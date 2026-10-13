const { useState, useEffect, useMemo, useRef } = React;

// --- Firebase setup ---------------------------------------------------------
// Paste the config object from Firebase Console → Project Settings → Your apps.
const firebaseConfig = {
  apiKey: "AIzaSyAWkcpebdnKflKKLeIIUo9ACr2WGy0y7VY",
  authDomain: "sport-organize.firebaseapp.com",
  projectId: "sport-organize",
  storageBucket: "sport-organize.firebasestorage.app",
  messagingSenderId: "122207828807",
  appId: "1:122207828807:web:2a7d6b821fdef7aebcaa62"
}; 
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
// Enable offline cache so the app still works without a connection.
db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
const googleProvider = new firebase.auth.GoogleAuthProvider();
// Only this user can edit; everyone else sees a read-only view.
const ADMIN_UID = "GiQwaYz7zGeG2bipauadUFO36NI3";
// Scorers may update match scores and the timer, but cannot touch rosters/members.
const SCORER_UIDS = new Set([
    "NhW9PukZFnVOmjnTOU5861Tfje03",
    "YqLY47sNTjeQPjjQ9W9OQFY6mcz1",
]);
const isScorerUid = (uid) => !!uid && SCORER_UIDS.has(uid);
// ---------------------------------------------------------------------------

const STORAGE_KEY = "volleyball-organizer-v3";
const LEGACY_KEY_V2 = "volleyball-organizer-v2";

const uid = () => Math.random().toString(36).slice(2, 10);

const makeRoster = (name, members = []) => ({
    id: uid(),
    name,
    members,
    sessions: [],
    currentSession: null,
});

// Firestore rejects nested arrays, so wrap each team as { players: [...] } on
// write and unwrap on read. Local state always uses the raw `teams: [[],[]]` shape.
const encodeSessionForCloud = (s) => {
    if (!s || !Array.isArray(s.teams)) return s;
    return { ...s, teams: s.teams.map(team => ({ players: team })) };
};
const decodeSessionFromCloud = (s) => {
    if (!s || !Array.isArray(s.teams)) return s;
    const first = s.teams[0];
    if (first && typeof first === "object" && !Array.isArray(first) && Array.isArray(first.players)) {
        return { ...s, teams: s.teams.map(w => Array.isArray(w?.players) ? w.players : []) };
    }
    return s;
};
const encodeStateForCloud = (state) => ({
    ...state,
    rosters: state.rosters.map(r => {
        // Drop any legacy per-roster tournaments; tournaments live at top level.
        const { tournaments, ...rest } = r;
        return {
            ...rest,
            currentSession: encodeSessionForCloud(rest.currentSession),
            sessions: (rest.sessions || []).map(encodeSessionForCloud),
        };
    }),
    tournaments: state.tournaments || [],
});
const decodeStateFromCloud = (state) => ({
    ...state,
    rosters: state.rosters.map(r => ({
        ...r,
        currentSession: decodeSessionFromCloud(r.currentSession),
        sessions: (r.sessions || []).map(decodeSessionFromCloud),
    })),
});

const normalizeState = (parsed) => {
    if (!parsed || typeof parsed !== "object") return null;
    if (Array.isArray(parsed.rosters) && parsed.rosters.length > 0) {
        const rosters = parsed.rosters.map(r => ({
            id: r.id || uid(),
            name: r.name || "Untitled Roster",
            members: Array.isArray(r.members) ? r.members : [],
            sessions: Array.isArray(r.sessions) ? r.sessions : [],
            currentSession: r.currentSession || null,
        }));
        // Tournaments live at the top level now (shared across rosters). If the
        // payload stored them per-roster (older format), fold them in.
        let tournaments = [];
        if (Array.isArray(parsed.tournaments)) {
            tournaments = parsed.tournaments.map(normalizeTournament);
        } else {
            parsed.rosters.forEach(r => {
                if (Array.isArray(r.tournaments)) {
                    r.tournaments.forEach(t => tournaments.push(normalizeTournament(t)));
                }
            });
        }
        const activeRosterId = rosters.some(r => r.id === parsed.activeRosterId)
            ? parsed.activeRosterId
            : rosters[0].id;
        const rosterTemplates = Array.isArray(parsed.rosterTemplates)
            ? parsed.rosterTemplates.map(tpl => ({
                id: tpl.id || uid(),
                name: tpl.name || "Untitled roster",
                members: Array.isArray(tpl.members) ? tpl.members.map(m => ({
                    id: m.id || uid(),
                    name: typeof m.name === "string" ? m.name : "",
                    category: [1, 2, 3].includes(Number(m.category)) ? Number(m.category) : 3,
                    rank: Number.isFinite(Number(m.rank)) ? Number(m.rank) : 0,
                })).filter(m => m.name) : [],
            })).filter(tpl => tpl.name)
            : [];
        return { rosters, activeRosterId, tournaments, rosterTemplates };
    }
    return null;
};

const loadState = () => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const normalized = normalizeState(JSON.parse(raw));
            if (normalized) return normalized;
        }
        const legacy = localStorage.getItem(LEGACY_KEY_V2);
        if (legacy) {
            const old = JSON.parse(legacy);
            const roster = {
                id: uid(),
                name: "MOCA Volleyball Group",
                members: Array.isArray(old.members) ? old.members : [],
                sessions: Array.isArray(old.sessions) ? old.sessions : [],
                currentSession: old.currentSession || null,
            };
            return { rosters: [roster], activeRosterId: roster.id };
        }
        return null;
    } catch { return null; }
};
const saveState = (state) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
};

/**
 * Balanced-team generation using category tiers + ranks.
 * - Groups available players by category.
 * - Sorts each category by rank (best first).
 * - Does a snake-draft globally: order rotates per round.
 * - The starting team order is randomized each run so reshuffles produce variety.
 */
const generateBalancedTeams = (availablePlayers, numTeams = 3) => {
    const byCategory = { 1: [], 2: [], 3: [] };
    availablePlayers.forEach(p => {
        const cat = p.category || 3;
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(p);
    });
    Object.values(byCategory).forEach(list =>
        list.sort((a, b) => (a.rank || 999) - (b.rank || 999))
    );

    // Flatten cat 1 -> 2 -> 3 (best to worst within each)
    const ordered = [...byCategory[1], ...byCategory[2], ...byCategory[3]];

    // Random starting rotation to vary results between reshuffles
    const baseOrder = [...Array(numTeams).keys()].sort(() => Math.random() - 0.5);

    const teams = Array.from({ length: numTeams }, () => []);
    ordered.forEach((player, i) => {
        const round = Math.floor(i / numTeams);
        const idxInRound = i % numTeams;
        const order = round % 2 === 0 ? baseOrder : [...baseOrder].reverse();
        teams[order[idxInRound]].push(player);
    });
    return teams;
};

const formatDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString(undefined, {
        weekday: "long", year: "numeric", month: "short", day: "numeric"
    });
};

const nextFriday = () => {
    const d = new Date();
    const day = d.getDay();
    const offset = (5 - day + 7) % 7 || 7;
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
};

const todayISO = () => new Date().toISOString().slice(0, 10);

const DEFAULT_MATCH_MIN = 11;
const DEFAULT_TIMEOUT_MIN = 1;
const TIMEOUTS_PER_TEAM = 2;

// Compute live match-timer state from the shared scoreboard fields.
// Shared state (synced via Firestore):
//   timerRunning: bool
//   timerStartAt: ms timestamp of current run (null when paused)
//   timerAccumMs: milliseconds accumulated across prior runs
const computeMatchTime = (state, matchDurationMin, now) => {
    const durationSec = Math.max(1, matchDurationMin || DEFAULT_MATCH_MIN) * 60;
    const accum = Number(state?.timerAccumMs) || 0;
    const liveMs = state?.timerRunning && state?.timerStartAt
        ? (now - state.timerStartAt) + accum
        : accum;
    const elapsedSec = Math.min(durationSec, Math.max(0, Math.floor(liveMs / 1000)));
    const remainingSec = durationSec - elapsedSec;
    return { elapsedSec, remainingSec, durationSec, expired: remainingSec === 0, elapsedMs: liveMs };
};
const computeTimeoutTime = (state, timeoutDurationMin, now) => {
    const sec = Math.max(1, timeoutDurationMin || DEFAULT_TIMEOUT_MIN) * 60;
    if (!state?.timeoutTeam || !state?.timeoutStartAt) {
        return { active: null, elapsedSec: 0, remainingSec: sec, expired: false };
    }
    const elapsedSec = Math.min(sec, Math.max(0, Math.floor((now - state.timeoutStartAt) / 1000)));
    return { active: state.timeoutTeam, elapsedSec, remainingSec: sec - elapsedSec, expired: elapsedSec >= sec };
};

// kind: 'teams' = teams added manually (big tournament, every state has a team).
// kind: 'roster' = roster of players; AI generates balanced teams (weekly games).
const TOURNAMENT_KIND_TEAMS = "teams";
const TOURNAMENT_KIND_ROSTER = "roster";

const makeTournament = (name, kind = TOURNAMENT_KIND_TEAMS, date, matchDurationMin, timeoutDurationMin) => ({
    id: uid(),
    name,
    kind,
    date: date || todayISO(),
    // Roster-kind only: pool of players with categories/ranks + availability.
    rosterMembers: [],
    availableIds: [],
    // Archived past rounds (roster-kind): each is a snapshot of a completed
    // week's teams + matches. Lets the user reshuffle without losing history.
    rounds: [],
    teams: [],
    matches: [],
    // One active-match slot per scorer (keyed by their uid). Lets multiple
    // scorers run parallel matches on different courts without clobbering
    // each other.
    activeMatches: {},
    endedAt: null,
    createdAt: new Date().toISOString(),
    matchDurationMin: Math.max(1, Number(matchDurationMin) || DEFAULT_MATCH_MIN),
    timeoutDurationMin: Math.max(1, Number(timeoutDurationMin) || DEFAULT_TIMEOUT_MIN),
});

// Distinct colors for tournament teams, cycled by team index. Enough for
// up to 12 teams before repeating. Avoid the app's neon-green accent so the
// winner highlight and other accented UI don't collide with team branding.
const TOURNAMENT_TEAM_COLORS = [
    "#FF4D6D", // red
    "#00F0FF", // cyan
    "#FFC107", // amber
    "#A855F7", // purple
    "#FB923C", // orange
    "#EC4899", // pink
    "#60A5FA", // blue
    "#F43F5E", // rose
    "#14B8A6", // teal
    "#F472B6", // light pink
    "#C084FC", // lavender
    "#FDBA74", // peach
];
const teamColor = (i) => TOURNAMENT_TEAM_COLORS[((i % TOURNAMENT_TEAM_COLORS.length) + TOURNAMENT_TEAM_COLORS.length) % TOURNAMENT_TEAM_COLORS.length];

// Round-robin standings. 2 pts per win, 1 per draw, 0 per loss.
// Tiebreakers: points, point diff, points for.
const computeStandings = (teams, matches) => {
    const stats = teams.map(t => ({
        team: t,
        played: 0, wins: 0, draws: 0, losses: 0,
        pointsFor: 0, pointsAgainst: 0, pts: 0,
    }));
    const byId = Object.fromEntries(stats.map(s => [s.team.id, s]));
    (matches || []).forEach(m => {
        const a = byId[m.teamAId];
        const b = byId[m.teamBId];
        if (!a || !b) return;
        const sA = m.scoreA || 0;
        const sB = m.scoreB || 0;
        a.played++; b.played++;
        a.pointsFor += sA; a.pointsAgainst += sB;
        b.pointsFor += sB; b.pointsAgainst += sA;
        if (sA > sB) { a.wins++; b.losses++; a.pts += 2; }
        else if (sB > sA) { b.wins++; a.losses++; b.pts += 2; }
        else { a.draws++; b.draws++; a.pts++; b.pts++; }
    });
    return [...stats].sort((x, y) => {
        if (y.pts !== x.pts) return y.pts - x.pts;
        const xDiff = x.pointsFor - x.pointsAgainst;
        const yDiff = y.pointsFor - y.pointsAgainst;
        if (yDiff !== xDiff) return yDiff - xDiff;
        return y.pointsFor - x.pointsFor;
    });
};

const normalizeTournament = (t) => {
    const activeMatches = {};
    if (t.activeMatches && typeof t.activeMatches === "object" && !Array.isArray(t.activeMatches)) {
        Object.entries(t.activeMatches).forEach(([key, m]) => {
            if (m && typeof m === "object") activeMatches[key] = m;
        });
    }
    // Older data had a single tournament.activeMatch. It's intentionally
    // dropped here: that one slot never belonged to any specific scorer, and
    // keeping it around would show as an un-ownable ghost on the Live tab.
    const kind = t.kind === TOURNAMENT_KIND_ROSTER ? TOURNAMENT_KIND_ROSTER : TOURNAMENT_KIND_TEAMS;
    const rosterMembers = Array.isArray(t.rosterMembers) ? t.rosterMembers.map(m => ({
        id: m.id || uid(),
        name: typeof m.name === "string" ? m.name : "",
        category: [1, 2, 3].includes(Number(m.category)) ? Number(m.category) : 3,
        rank: Number.isFinite(Number(m.rank)) ? Number(m.rank) : 0,
    })).filter(m => m.name) : [];
    const memberIdSet = new Set(rosterMembers.map(m => m.id));
    const availableIds = Array.isArray(t.availableIds)
        ? t.availableIds.filter(id => memberIdSet.has(id))
        : rosterMembers.map(m => m.id);
    const rounds = Array.isArray(t.rounds) ? t.rounds.map(r => ({
        id: r.id || uid(),
        date: r.date || todayISO(),
        teams: Array.isArray(r.teams) ? r.teams.map(team => ({
            id: team.id || uid(),
            name: team.name || "Team",
            players: Array.isArray(team.players) ? team.players.filter(p => typeof p === "string") : [],
        })) : [],
        matches: Array.isArray(r.matches) ? r.matches : [],
    })) : [];
    return {
        id: t.id || uid(),
        name: t.name || "Tournament",
        kind,
        date: t.date || todayISO(),
        rosterMembers,
        availableIds,
        rounds,
        teams: Array.isArray(t.teams) ? t.teams.map(team => ({
            id: team.id || uid(),
            name: team.name || "Team",
            // v1 used playerIds (roster refs); v2+ uses free-text players.
            players: Array.isArray(team.players) ? team.players.filter(p => typeof p === "string") : [],
        })) : [],
        // Roster-kind only: after admin generates teams, must click Finalize
        // before viewers see them. Default true so pre-existing data (and
        // teams-kind tournaments, which don't use the gate) stay visible.
        teamsFinalized: t.teamsFinalized === undefined ? true : !!t.teamsFinalized,
        // Admin-authored ordered list of match pairings. Each: { id, teamAId,
        // teamBId }. (`scheduledAt` from older data is dropped — times aren't
        // part of the schedule anymore.)
        schedule: Array.isArray(t.schedule) ? t.schedule.map(s => ({
            id: s.id || uid(),
            teamAId: typeof s.teamAId === "string" ? s.teamAId : null,
            teamBId: typeof s.teamBId === "string" ? s.teamBId : null,
        })).filter(s => s.teamAId && s.teamBId) : [],
        // Default true so pre-existing data stays visible. Admin publishes
        // a reshuffled schedule by setting this true.
        scheduleFinalized: t.scheduleFinalized === undefined ? true : !!t.scheduleFinalized,
        matches: Array.isArray(t.matches) ? t.matches : [],
        activeMatches,
        endedAt: t.endedAt || null,
        createdAt: t.createdAt || new Date().toISOString(),
        matchDurationMin: Number.isFinite(t.matchDurationMin) && t.matchDurationMin > 0
            ? t.matchDurationMin
            : DEFAULT_MATCH_MIN,
        timeoutDurationMin: Number.isFinite(t.timeoutDurationMin) && t.timeoutDurationMin > 0
            ? t.timeoutDurationMin
            : DEFAULT_TIMEOUT_MIN,
    };
};

const teamBreakdown = (team) => {
    const counts = { 1: 0, 2: 0, 3: 0 };
    team.forEach(p => { counts[p.category || 3]++; });
    return counts;
};

function Toast({ message, onDone }) {
    useEffect(() => {
        const t = setTimeout(onDone, 2000);
        return () => clearTimeout(t);
    }, [message]);
    return <div className="toast">{message}</div>;
}

function CatBadge({ category, rank }) {
    return (
        <span className={`cat-badge c${category}`}>
            C{category}{rank != null && ` · #${rank}`}
        </span>
    );
}

function MembersView({ members, setMembers, resetToPreset }) {
    const [name, setName] = useState("");
    const [category, setCategory] = useState(3);

    const addMember = () => {
        const trimmed = name.trim();
        if (!trimmed) return;
        if (members.some(m => m.name.toLowerCase() === trimmed.toLowerCase())) return;
        const nextRank = Math.max(0, ...members.filter(m => m.category === category).map(m => m.rank || 0)) + 1;
        setMembers([...members, { id: uid(), name: trimmed, category, rank: nextRank }]);
        setName("");
    };

    const updateMember = (id, field, value) => {
        setMembers(members.map(m => m.id === id ? { ...m, [field]: value } : m));
    };

    const removeMember = (id) => {
        if (!confirm("Remove this member?")) return;
        setMembers(members.filter(m => m.id !== id));
    };

    const grouped = { 1: [], 2: [], 3: [] };
    members.forEach(m => { grouped[m.category || 3].push(m); });
    Object.values(grouped).forEach(list =>
        list.sort((a, b) => (a.rank || 999) - (b.rank || 999))
    );

    return (
        <div>
            <div className="card">
                <h2>Add Player</h2>
                <div className="row">
                    <input
                        type="text"
                        value={name}
                        placeholder="Player name"
                        onChange={e => setName(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && addMember()}
                    />
                    <select value={category} onChange={e => setCategory(Number(e.target.value))}>
                        <option value={1}>Category 1</option>
                        <option value={2}>Category 2</option>
                        <option value={3}>Category 3</option>
                    </select>
                    <button className="btn" onClick={addMember}>Add</button>
                </div>
            </div>
            <div className="card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                    <h2 style={{ margin: 0 }}>Roster ({members.length})</h2>
                    <button className="btn btn-secondary" onClick={() => {
                        if (confirm("Replace current roster with the preset list?")) resetToPreset();
                    }}>Reset to Preset</button>
                </div>
                {members.length === 0 ? (
                    <div className="empty">No members. Add players above or reset to preset.</div>
                ) : (
                    [1, 2, 3].map(cat => (
                        grouped[cat].length > 0 && (
                            <div key={cat}>
                                <div className="cat-group-header">
                                    Category {cat}
                                    <span className="count">· {grouped[cat].length} players</span>
                                </div>
                                <div className="member-list">
                                    {grouped[cat].map(m => (
                                        <div className="member-row" key={m.id}>
                                            <span className="member-name">{m.name}</span>
                                            <select
                                                value={m.category}
                                                onChange={e => updateMember(m.id, "category", Number(e.target.value))}
                                                style={{ minWidth: "100px" }}
                                            >
                                                <option value={1}>Cat 1</option>
                                                <option value={2}>Cat 2</option>
                                                <option value={3}>Cat 3</option>
                                            </select>
                                            <input
                                                type="number"
                                                min="1"
                                                value={m.rank || ""}
                                                onChange={e => updateMember(m.id, "rank", Number(e.target.value) || 0)}
                                                title="Rank (lower = better)"
                                            />
                                            <button className="icon-btn" onClick={() => removeMember(m.id)} title="Remove">✕</button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )
                    ))
                )}
            </div>
        </div>
    );
}

// Pretty match result card used by Scoreboard and both History views.
function MatchCard({ match, index }) {
    const aLabel = String.fromCharCode(65 + match.teamIdxA);
    const bLabel = String.fromCharCode(65 + match.teamIdxB);
    const aWin = match.scoreA > match.scoreB;
    const bWin = match.scoreB > match.scoreA;
    const mins = Math.floor((match.durationSec || 0) / 60);
    const secs = (match.durationSec || 0) % 60;
    return (
        <div className="match-card">
            <div className="match-card-header">
                <span className="match-card-num">Match {index + 1}</span>
                <span className="match-card-time">
                    {mins}:{secs.toString().padStart(2, "0")}
                </span>
            </div>
            <div className="match-card-body">
                <div className={`match-side team-${match.teamIdxA + 1}${aWin ? " winner" : ""}`}>
                    <span className="match-side-label">Team {aLabel}</span>
                    <span className="match-side-score">{match.scoreA}</span>
                </div>
                <div className={`match-side team-${match.teamIdxB + 1}${bWin ? " winner" : ""}`}>
                    <span className="match-side-label">Team {bLabel}</span>
                    <span className="match-side-score">{match.scoreB}</span>
                </div>
            </div>
        </div>
    );
}

// Bell-like chime that plays for ~4 seconds when the timer expires.
// No audio file — synthesised in-browser via Web Audio API.
const playTimerAlarm = () => {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const now = ctx.currentTime;

        // Bell = sine fundamental + softer 2nd harmonic, both decaying exponentially.
        const bell = (startAt, freq, dur = 1.6, vol = 0.4) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "sine";
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, startAt);
            gain.gain.linearRampToValueAtTime(vol, startAt + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.001, startAt + dur);
            osc.connect(gain).connect(ctx.destination);
            osc.start(startAt);
            osc.stop(startAt + dur);

            const osc2 = ctx.createOscillator();
            const gain2 = ctx.createGain();
            osc2.type = "sine";
            osc2.frequency.value = freq * 2.01;
            gain2.gain.setValueAtTime(0, startAt);
            gain2.gain.linearRampToValueAtTime(vol * 0.4, startAt + 0.01);
            gain2.gain.exponentialRampToValueAtTime(0.001, startAt + dur * 0.75);
            osc2.connect(gain2).connect(ctx.destination);
            osc2.start(startAt);
            osc2.stop(startAt + dur * 0.75);
        };

        // Ascending C major arpeggio: C5 → E5 → G5, then a long final C6.
        bell(now,        523.25, 1.4);
        bell(now + 0.55, 659.25, 1.4);
        bell(now + 1.10, 783.99, 1.4);
        bell(now + 1.80, 1046.50, 2.4, 0.5);

        setTimeout(() => ctx.close().catch(() => {}), 4500);
    } catch (e) {
        console.warn("[alarm] could not play:", e);
    }
};

function Scoreboard({ session, teams, onUpdate, onEndMatch, onSaveSession, showToast, canEdit, matchDurationMin, timeoutDurationMin }) {
    const teamLabels = teams.map((_, i) => String.fromCharCode(65 + i));
    const sb = session.scoreboard || {};
    // Default: first two teams play; clamp to valid indices.
    let teamIdxA = Number.isInteger(sb.teamIdxA) ? sb.teamIdxA : 0;
    let teamIdxB = Number.isInteger(sb.teamIdxB) ? sb.teamIdxB : 1;
    if (teamIdxA >= teams.length) teamIdxA = 0;
    if (teamIdxB >= teams.length) teamIdxB = Math.min(1, teams.length - 1);
    if (teamIdxA === teamIdxB) teamIdxB = (teamIdxA + 1) % teams.length;
    const scoreA = sb.scoreA || 0;
    const scoreB = sb.scoreB || 0;
    const timeoutsUsedA = sb.timeoutsUsedA || 0;
    const timeoutsUsedB = sb.timeoutsUsedB || 0;

    const [now, setNow] = useState(() => Date.now());
    const alarmFiredRef = useRef(false);
    const toAlarmFiredRef = useRef(false);

    const running = !!sb.timerRunning;
    const timeoutTeam = sb.timeoutTeam || null;

    useEffect(() => {
        if (!running && !timeoutTeam) return;
        setNow(Date.now());
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [running, timeoutTeam]);

    const match = computeMatchTime(sb, matchDurationMin, now);
    const timeoutT = computeTimeoutTime(sb, timeoutDurationMin, now);
    const elapsedSec = match.elapsedSec;
    const remainingSec = match.remainingSec;
    const mm = Math.floor(remainingSec / 60);
    const ss = remainingSec % 60;
    const timeExpired = match.expired;
    const timerNotStarted = canEdit && !running && elapsedSec === 0 && !timeoutTeam;
    const timerPaused = canEdit && !running && elapsedSec > 0 && !timeExpired && !timeoutTeam;
    const toMM = Math.floor(timeoutT.remainingSec / 60);
    const toSS = timeoutT.remainingSec % 60;

    // Auto-pause the main timer when it hits 0 (owner writes, everyone plays alarm once).
    useEffect(() => {
        if (!running || !timeExpired) {
            if (!running && elapsedSec === 0) alarmFiredRef.current = false;
            return;
        }
        if (alarmFiredRef.current) return;
        alarmFiredRef.current = true;
        playTimerAlarm();
        if (canEdit) {
            onUpdate({
                timerRunning: false,
                timerStartAt: null,
                timerAccumMs: match.durationSec * 1000,
            });
        }
    }, [running, timeExpired, elapsedSec, canEdit]);

    // Auto-end timeout + auto-resume main timer when timeout expires.
    useEffect(() => {
        if (!timeoutTeam) { toAlarmFiredRef.current = false; return; }
        if (!timeoutT.expired) return;
        if (toAlarmFiredRef.current) return;
        toAlarmFiredRef.current = true;
        playTimerAlarm();
        if (canEdit) {
            onUpdate({
                timeoutTeam: null,
                timeoutStartAt: null,
                timerRunning: true,
                timerStartAt: Date.now(),
            });
        }
    }, [timeoutTeam, timeoutT.expired, canEdit]);

    const bump = (which, delta) => {
        if (!canEdit) return;
        if (which === "A") onUpdate({ scoreA: Math.max(0, scoreA + delta), teamIdxA, teamIdxB });
        else onUpdate({ scoreB: Math.max(0, scoreB + delta), teamIdxA, teamIdxB });
    };

    const pickTeam = (which, newIdx) => {
        if (!canEdit) return;
        const reset = {
            scoreA: 0, scoreB: 0,
            timeoutsUsedA: 0, timeoutsUsedB: 0,
            timerRunning: false, timerStartAt: null, timerAccumMs: 0,
            timeoutTeam: null, timeoutStartAt: null,
        };
        if (which === "A") {
            const nextB = newIdx === teamIdxB ? teamIdxA : teamIdxB;
            onUpdate({ teamIdxA: newIdx, teamIdxB: nextB, ...reset });
        } else {
            const nextA = newIdx === teamIdxA ? teamIdxB : teamIdxA;
            onUpdate({ teamIdxA: nextA, teamIdxB: newIdx, ...reset });
        }
    };

    const resetScores = () => {
        if (!canEdit) return;
        if (!confirm("Reset both scores to 0?")) return;
        onUpdate({ scoreA: 0, scoreB: 0, teamIdxA, teamIdxB });
    };

    const toggleTimer = () => {
        if (!canEdit) return;
        if (running) {
            onUpdate({
                timerRunning: false,
                timerStartAt: null,
                timerAccumMs: match.elapsedMs,
            });
        } else {
            onUpdate({
                timerRunning: true,
                timerStartAt: Date.now(),
            });
        }
    };

    const resetTimer = () => {
        if (!canEdit) return;
        if (elapsedSec > 0 || timeoutTeam) {
            if (!confirm("Reset the match timer back to 0? Any active timeout will also be cleared.")) return;
        }
        alarmFiredRef.current = false;
        toAlarmFiredRef.current = false;
        onUpdate({
            timerRunning: false,
            timerStartAt: null,
            timerAccumMs: 0,
            timeoutTeam: null,
            timeoutStartAt: null,
        });
    };

    const callTimeout = (which) => {
        if (!canEdit) return;
        if (timeoutTeam) return;
        const used = which === "A" ? timeoutsUsedA : timeoutsUsedB;
        if (used >= TIMEOUTS_PER_TEAM) return;
        onUpdate({
            timerRunning: false,
            timerStartAt: null,
            timerAccumMs: match.elapsedMs,
            timeoutTeam: which,
            timeoutStartAt: Date.now(),
            [which === "A" ? "timeoutsUsedA" : "timeoutsUsedB"]: used + 1,
        });
    };

    const endTimeout = () => {
        if (!canEdit) return;
        onUpdate({
            timeoutTeam: null,
            timeoutStartAt: null,
            timerRunning: true,
            timerStartAt: Date.now(),
        });
    };

    // Dismiss the active timeout WITHOUT auto-resuming the match timer.
    // Escape hatch when a timeout was called in error or needs to end without
    // play restarting immediately.
    const stopTimeout = () => {
        if (!canEdit) return;
        if (!timeoutTeam) return;
        toAlarmFiredRef.current = false;
        onUpdate({
            timeoutTeam: null,
            timeoutStartAt: null,
        });
    };

    const endMatch = () => {
        if (!canEdit) return;
        if (scoreA === 0 && scoreB === 0) {
            if (!confirm("Both scores are 0. Record this match anyway?")) return;
        } else if (!confirm("End this match? Score will be saved to the session.")) {
            return;
        }
        onEndMatch({
            id: uid(),
            teamIdxA, teamIdxB,
            scoreA, scoreB,
            durationSec: elapsedSec,
            endedAt: new Date().toISOString(),
        });
        alarmFiredRef.current = false;
        toAlarmFiredRef.current = false;
        showToast?.("Match recorded");
    };

    // Weekly uses fixed team colors A/B/C.
    const weeklyTeamColor = (idx) => ["#FF4D6D", "#00F0FF", "#FFC107"][idx % 3];
    const timeoutColor = timeoutTeam
        ? weeklyTeamColor(timeoutTeam === "A" ? teamIdxA : teamIdxB)
        : null;

    const renderScoreTile = (which, idx, score) => {
        const used = which === "A" ? timeoutsUsedA : timeoutsUsedB;
        const remaining = Math.max(0, TIMEOUTS_PER_TEAM - used);
        return (
            <div key={which} className={`scoreboard-team team-${idx + 1}`}>
                {teams.length > 2 ? (
                    <select
                        className="scoreboard-team-picker"
                        value={idx}
                        onChange={e => pickTeam(which, Number(e.target.value))}
                        disabled={!canEdit}
                    >
                        {teams.map((_, i) => (
                            <option key={i} value={i}>Team {teamLabels[i]}</option>
                        ))}
                    </select>
                ) : (
                    <div className="jersey">{teamLabels[idx]}</div>
                )}
                <div className="score-value">{score}</div>
                <div className="score-controls">
                    <button className="btn btn-secondary" onClick={() => bump(which, -1)} disabled={!canEdit} aria-label={`Team ${teamLabels[idx]} minus one`}>−</button>
                    <button className="btn" onClick={() => bump(which, +1)} disabled={!canEdit} aria-label={`Team ${teamLabels[idx]} plus one`}>+</button>
                </div>
                {canEdit && (
                    <div className="timeout-row">
                        <div className="timeout-dots" aria-label={`${remaining} of ${TIMEOUTS_PER_TEAM} timeouts remaining`}>
                            {Array.from({ length: TIMEOUTS_PER_TEAM }).map((_, i) => (
                                <span key={i} className={`timeout-dot${i < used ? " used" : ""}`}></span>
                            ))}
                        </div>
                        <button
                            className="btn btn-secondary timeout-btn"
                            onClick={() => callTimeout(which)}
                            disabled={remaining === 0 || !!timeoutTeam || timeExpired}
                            title={remaining === 0 ? "No timeouts left" : `Call timeout (${remaining} left)`}
                        >
                            ⏱ Timeout
                        </button>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="card">
            <h2>Scoreboard</h2>
            {timeoutTeam && (
                <div
                    className="timeout-banner"
                    style={{
                        borderColor: timeoutColor,
                        background: `${timeoutColor}1a`,
                    }}
                >
                    <div className="timeout-banner-head">
                        <span className="timeout-banner-label" style={{ color: timeoutColor }}>
                            ⏱ Timeout · Team {teamLabels[timeoutTeam === "A" ? teamIdxA : teamIdxB]}
                        </span>
                        <span className="timeout-banner-time" style={{ color: timeoutColor }}>
                            {toMM}:{toSS.toString().padStart(2, "0")}
                        </span>
                    </div>
                    <div className="timeout-banner-actions">
                        <button className="btn" onClick={endTimeout}>End timeout</button>
                        <button
                            className="btn btn-secondary emergency-btn"
                            onClick={stopTimeout}
                            title="Emergency: end timeout WITHOUT restarting the match timer (use only if the match can't resume — injury, equipment issue, etc.)"
                        >⚠ Emergency: end without resuming</button>
                    </div>
                </div>
            )}
            {!timeoutTeam && (timerNotStarted || timerPaused) && (
                <div className="timer-reminder">
                    <span className="timer-reminder-icon">⏱</span>
                    <span className="timer-reminder-text">
                        {timerNotStarted
                            ? "Don't forget to start the timer when the match begins."
                            : "Timer is paused — resume it to keep tracking the match."}
                    </span>
                </div>
            )}
            <div className={`scoreboard-timer${timeExpired ? " expired" : ""}`}>
                <div className="timer-display">
                    {mm}:{ss.toString().padStart(2, "0")}
                </div>
                {canEdit && (
                    <div className="timer-controls">
                        <button
                            className="btn"
                            onClick={toggleTimer}
                            disabled={(timeExpired && !running) || !!timeoutTeam}
                        >
                            {running ? "Pause" : (elapsedSec > 0 ? "Resume" : "Start")}
                        </button>
                        <button className="btn btn-secondary" onClick={resetTimer}>Reset</button>
                        <span className="duration-static">
                            {matchDurationMin || DEFAULT_MATCH_MIN} min match
                        </span>
                    </div>
                )}
            </div>
            <div className="scoreboard-teams scoreboard-2team">
                {renderScoreTile("A", teamIdxA, scoreA)}
                <div className="vs-label">VS</div>
                {renderScoreTile("B", teamIdxB, scoreB)}
            </div>
            {canEdit && (
                <div className="btn-row">
                    <button className="btn btn-danger" onClick={resetScores}>Reset Scores</button>
                    <button className="btn" onClick={endMatch}>End Match</button>
                    {onSaveSession && (
                        <button className="btn btn-danger save-session-btn" onClick={onSaveSession}>Save Session</button>
                    )}
                </div>
            )}
            {Array.isArray(session.matches) && session.matches.length > 0 && (
                <>
                    <h3 style={{ marginTop: "1.5rem" }}>Matches this session</h3>
                    <div className="match-list">
                        {session.matches.map((m, i) => (
                            <MatchCard key={m.id || i} match={m} index={i} />
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

function ThisWeekView({ members, currentSession, setCurrentSession, saveSession, showToast }) {
    const [date, setDate] = useState(currentSession?.date || nextFriday());
    const [filter, setFilter] = useState("all");
    const [selectedPlayer, setSelectedPlayer] = useState(null); // { playerId, fromTeamIdx }
    const [dragOverTeam, setDragOverTeam] = useState(null);
    const [newMatchMin, setNewMatchMin] = useState(DEFAULT_MATCH_MIN);
    const [newTimeoutMin, setNewTimeoutMin] = useState(DEFAULT_TIMEOUT_MIN);
    const locked = !!currentSession?.teamsFinalized;

    // Move a player and insert at an exact position. If toIdx is null, append.
    // Correctly handles same-team moves (index shift after removal).
    const movePlayerTo = (playerId, fromTeamIdx, toTeamIdx, toIdx) => {
        if (locked) return;
        if (!currentSession?.teams) return;
        const teams = currentSession.teams.map(t => [...t]);
        const srcIdx = teams[fromTeamIdx].indexOf(playerId);
        if (srcIdx === -1) return;
        teams[fromTeamIdx].splice(srcIdx, 1);
        let insertAt = toIdx == null ? teams[toTeamIdx].length : toIdx;
        if (fromTeamIdx === toTeamIdx && srcIdx < insertAt) insertAt -= 1;
        teams[toTeamIdx].splice(insertAt, 0, playerId);
        // No-op guard: skip state update if nothing changed
        const same = currentSession.teams.every((t, i) =>
            t.length === teams[i].length && t.every((v, j) => v === teams[i][j])
        );
        if (same) { setSelectedPlayer(null); return; }
        setCurrentSession({ ...currentSession, teams });
        setSelectedPlayer(null);
    };

    // Swap two players (works across teams or within the same team).
    const swapPlayers = (p1, t1, p2, t2) => {
        if (locked) return;
        if (!currentSession?.teams) return;
        const teams = currentSession.teams.map(t => [...t]);
        const i1 = teams[t1].indexOf(p1);
        const i2 = teams[t2].indexOf(p2);
        if (i1 === -1 || i2 === -1) return;
        teams[t1][i1] = p2;
        teams[t2][i2] = p1;
        setCurrentSession({ ...currentSession, teams });
        setSelectedPlayer(null);
    };

    const handlePlayerTap = (playerId, teamIdx) => {
        if (locked) return;
        if (selectedPlayer?.playerId === playerId) {
            setSelectedPlayer(null);
        } else if (selectedPlayer) {
            swapPlayers(selectedPlayer.playerId, selectedPlayer.fromTeamIdx, playerId, teamIdx);
        } else {
            setSelectedPlayer({ playerId, fromTeamIdx: teamIdx });
        }
    };

    const handleTeamTap = (teamIdx) => {
        if (locked) return;
        if (selectedPlayer) movePlayerTo(selectedPlayer.playerId, selectedPlayer.fromTeamIdx, teamIdx, null);
    };

    useEffect(() => {
        if (currentSession) setDate(currentSession.date);
    }, [currentSession?.id]);

    const startSession = () => {
        setCurrentSession({
            id: uid(),
            date,
            available: members.map(m => m.id),
            teams: null,
            locked: false,
            matchDurationMin: Math.max(1, Number(newMatchMin) || DEFAULT_MATCH_MIN),
            timeoutDurationMin: Math.max(1, Number(newTimeoutMin) || DEFAULT_TIMEOUT_MIN),
        });
    };

    const setMatchDuration = (val) => {
        if (locked) return;
        setCurrentSession({ ...currentSession, matchDurationMin: Math.max(1, Number(val) || DEFAULT_MATCH_MIN) });
    };
    const setTimeoutDuration = (val) => {
        if (locked) return;
        setCurrentSession({ ...currentSession, timeoutDurationMin: Math.max(1, Number(val) || DEFAULT_TIMEOUT_MIN) });
    };

    const toggleOut = (memberId) => {
        if (!currentSession || currentSession.locked || locked) return;
        const available = currentSession.available.includes(memberId)
            ? currentSession.available.filter(id => id !== memberId)
            : [...currentSession.available, memberId];
        setCurrentSession({ ...currentSession, available, teams: null });
    };

    const markAllIn = () => {
        if (locked) return;
        setCurrentSession({ ...currentSession, available: members.map(m => m.id), teams: null });
    };
    const markAllOut = () => {
        if (locked) return;
        setCurrentSession({ ...currentSession, available: [], teams: null });
    };

    const generateTeams = () => {
        if (!currentSession) return;
        const availablePlayers = members.filter(m => currentSession.available.includes(m.id));
        const numTeams = availablePlayers.length >= 17 ? 3 : 2;
        const teams = generateBalancedTeams(availablePlayers, numTeams).map(team => team.map(p => p.id));
        setCurrentSession({ ...currentSession, teams, teamsFinalized: false });
        setSelectedPlayer(null);
        showToast(`${numTeams} teams generated`);
    };

    const finalizeTeams = () => {
        if (!currentSession?.teams) return;
        setCurrentSession({ ...currentSession, teamsFinalized: true });
        showToast("Match is live");
    };

    const editTeams = () => {
        if (!currentSession?.teamsFinalized) return;
        if (!confirm("Edit teams? The match will stop being live until you finalize again.")) return;
        setCurrentSession({ ...currentSession, teamsFinalized: false });
    };

    const lockAndSave = () => {
        if (!currentSession?.teams) return;
        if (!confirm("Save and end this session? Scoring will stop and the session will be archived.")) return;
        saveSession({ ...currentSession, locked: true });
        setCurrentSession(null);
        showToast("Session saved");
    };

    const copyTeamsText = () => {
        if (!currentSession?.teams) return;
        const teamLabels = ["Team A", "Team B", "Team C"];
        const lines = [`🏐 Volleyball — ${formatDate(currentSession.date)}`, ""];
        currentSession.teams.forEach((teamIds, i) => {
            const team = teamIds.map(id => members.find(m => m.id === id)).filter(Boolean);
            lines.push(`${teamLabels[i]} (${team.length})`);
            team.forEach(p => lines.push(`  • ${p.name}`));
            lines.push("");
        });
        navigator.clipboard.writeText(lines.join("\n")).then(() => {
            showToast("Teams copied — paste into WhatsApp");
        });
    };

    if (!currentSession) {
        return (
            <div className="card">
                <h2>Start a new session</h2>
                <div className="row" style={{ marginBottom: "1rem" }}>
                    <input type="date" value={date} onChange={e => setDate(e.target.value)} />
                </div>
                <div className="duration-grid">
                    <label className="duration-field">
                        <span>Match length</span>
                        <input type="number" min="1" max="99"
                            value={newMatchMin}
                            onChange={e => setNewMatchMin(Math.max(1, Number(e.target.value) || DEFAULT_MATCH_MIN))}
                        />
                        <span className="duration-unit">min</span>
                    </label>
                    <label className="duration-field">
                        <span>Timeout length</span>
                        <input type="number" min="1" max="10"
                            value={newTimeoutMin}
                            onChange={e => setNewTimeoutMin(Math.max(1, Number(e.target.value) || DEFAULT_TIMEOUT_MIN))}
                        />
                        <span className="duration-unit">min</span>
                    </label>
                    <p className="help-text duration-help">
                        Each team gets {TIMEOUTS_PER_TEAM} timeouts per match. These values can't be changed once the match goes live.
                    </p>
                </div>
                <button className="btn" onClick={startSession} disabled={members.length === 0}>
                    {members.length === 0 ? "Add members first" : "Start Session"}
                </button>
            </div>
        );
    }

    const availablePlayers = members.filter(m => currentSession.available.includes(m.id));
    const breakdown = { 1: 0, 2: 0, 3: 0 };
    availablePlayers.forEach(p => breakdown[p.category || 3]++);

    const visibleMembers = members
        .filter(m => filter === "all" || m.category === Number(filter))
        .sort((a, b) => {
            if (a.category !== b.category) return a.category - b.category;
            return (a.rank || 999) - (b.rank || 999);
        });

    return (
        <div>
            <div className={`card${locked ? " card-locked" : ""}`}>
                <h2>{formatDate(currentSession.date)}</h2>
                <div className="stats-bar">
                    <div className="stat">
                        <div className="num">{currentSession.available.length}</div>
                        <div className="label">In</div>
                    </div>
                    <div className="stat c1">
                        <div className="num">{breakdown[1]}</div>
                        <div className="label">Cat 1</div>
                    </div>
                    <div className="stat c2">
                        <div className="num">{breakdown[2]}</div>
                        <div className="label">Cat 2</div>
                    </div>
                    <div className="stat c3">
                        <div className="num">{breakdown[3]}</div>
                        <div className="label">Cat 3</div>
                    </div>
                    <div className="stat danger">
                        <div className="num">{members.length - currentSession.available.length}</div>
                        <div className="label">Out</div>
                    </div>
                </div>

                <div className="filter-bar">
                    {["all", "1", "2", "3"].map(f => (
                        <button
                            key={f}
                            className={`filter-btn ${filter === f ? "active" : ""}`}
                            onClick={() => setFilter(f)}
                        >
                            {f === "all" ? "All" : `Category ${f}`}
                        </button>
                    ))}
                    <button className="filter-btn" onClick={markAllIn}>Everyone in</button>
                    <button className="filter-btn" onClick={markAllOut}>Everyone out</button>
                </div>

                <h3>Tap players who are NOT playing</h3>
                <div className="member-list">
                    {visibleMembers.map(m => {
                        const isOut = !currentSession.available.includes(m.id);
                        return (
                            <div
                                key={m.id}
                                className={`member-row selectable ${isOut ? "out" : ""}`}
                                onClick={() => toggleOut(m.id)}
                            >
                                <div className="checkbox">{isOut && "✕"}</div>
                                <span className="member-name">{m.name}</span>
                                <CatBadge category={m.category} rank={m.rank} />
                            </div>
                        );
                    })}
                </div>

                <div className="btn-row">
                    <button
                        className="btn"
                        onClick={generateTeams}
                        disabled={currentSession.available.length < 3 || locked}
                        title={locked ? "Finalized — tap Edit Teams first" : ""}
                    >
                        {currentSession.teams ? "Reshuffle Teams" : "Generate Teams"}
                    </button>
                    <button className="btn btn-secondary" onClick={() => {
                        if (confirm("Discard this session?")) setCurrentSession(null);
                    }}>Cancel</button>
                </div>
                {currentSession.available.length < 3 && (
                    <p className="help-text">Need at least 3 players to form teams.</p>
                )}
                {locked && (
                    <p className="help-text">Teams are locked while the match is live. Tap <strong>Edit Teams</strong> to make changes.</p>
                )}
            </div>

            {currentSession.teams && (
                <div className="card">
                    <h2>Teams{locked && <span className="locked-badge" title="Teams are finalized">🔒 LIVE</span>}</h2>
                    {!locked && selectedPlayer && (() => {
                        const p = members.find(m => m.id === selectedPlayer.playerId);
                        return (
                            <div className="move-hint">
                                <strong>{p?.name}</strong> picked up — tap another team to move, or tap <strong>{p?.name}</strong> again to cancel.
                            </div>
                        );
                    })()}
                    <div className="teams-grid">
                        {currentSession.teams.map((teamIds, i) => {
                            const team = teamIds.map(id => members.find(m => m.id === id)).filter(Boolean);
                            const droppable = !locked && selectedPlayer != null && selectedPlayer.fromTeamIdx !== i;
                            const dragOver = !locked && dragOverTeam === i;
                            const teamHandlers = locked ? {} : {
                                onClick: () => handleTeamTap(i),
                                onDragOver: e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragOverTeam !== i) setDragOverTeam(i); },
                                onDragLeave: e => {
                                    if (!e.currentTarget.contains(e.relatedTarget)) setDragOverTeam(null);
                                },
                                onDrop: e => {
                                    e.preventDefault();
                                    setDragOverTeam(null);
                                    try {
                                        const data = JSON.parse(e.dataTransfer.getData("application/json"));
                                        movePlayerTo(data.playerId, data.fromTeamIdx, i, null);
                                    } catch {}
                                },
                            };
                            return (
                                <div
                                    key={i}
                                    className={`team team-${i + 1} ${droppable ? "droppable" : ""} ${dragOver ? "drag-over" : ""} ${locked ? "locked" : ""}`}
                                    {...teamHandlers}
                                >
                                    <div className="team-header">
                                        <div className="jersey">{String.fromCharCode(65 + i)}</div>
                                        <div className="team-title">
                                            <span className="name">Team {String.fromCharCode(65 + i)}</span>
                                            <span className="meta">{team.length} Players</span>
                                        </div>
                                    </div>
                                    <div className="team-players">
                                        {team.map((p, playerIdx) => {
                                            const playerHandlers = locked ? {
                                                onClick: e => e.stopPropagation(),
                                            } : {
                                                onDragStart: e => {
                                                    e.dataTransfer.setData("application/json", JSON.stringify({ playerId: p.id, fromTeamIdx: i }));
                                                    e.dataTransfer.effectAllowed = "move";
                                                    e.currentTarget.classList.add("dragging");
                                                },
                                                onDragEnd: e => {
                                                    e.currentTarget.classList.remove("dragging");
                                                    e.currentTarget.classList.remove("drop-before", "drop-after");
                                                    setDragOverTeam(null);
                                                },
                                                onDragOver: e => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    e.dataTransfer.dropEffect = "move";
                                                    const rect = e.currentTarget.getBoundingClientRect();
                                                    const after = (e.clientY - rect.top) > rect.height / 2;
                                                    e.currentTarget.classList.toggle("drop-before", !after);
                                                    e.currentTarget.classList.toggle("drop-after", after);
                                                    if (dragOverTeam !== i) setDragOverTeam(i);
                                                },
                                                onDragLeave: e => {
                                                    e.currentTarget.classList.remove("drop-before", "drop-after");
                                                },
                                                onDrop: e => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    const rect = e.currentTarget.getBoundingClientRect();
                                                    const after = (e.clientY - rect.top) > rect.height / 2;
                                                    e.currentTarget.classList.remove("drop-before", "drop-after");
                                                    setDragOverTeam(null);
                                                    try {
                                                        const data = JSON.parse(e.dataTransfer.getData("application/json"));
                                                        movePlayerTo(data.playerId, data.fromTeamIdx, i, playerIdx + (after ? 1 : 0));
                                                    } catch {}
                                                },
                                                onClick: e => { e.stopPropagation(); handlePlayerTap(p.id, i); },
                                            };
                                            return (
                                                <div
                                                    key={p.id}
                                                    className={`team-player ${selectedPlayer?.playerId === p.id ? "selected" : ""}`}
                                                    draggable={!locked}
                                                    style={locked ? { cursor: "default" } : undefined}
                                                    {...playerHandlers}
                                                >
                                                    <span>{p.name}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    {!locked && (
                        <p className="help-text">
                            Drag a player onto another player to place them at that exact spot (works within the same team too). Drop on empty team space to add to the end. On mobile: tap a player, then tap another player to swap, or tap a team card to move to its end.
                        </p>
                    )}
                    <div className="duration-grid pre-match-settings">
                        <label className="duration-field">
                            <span>Match length</span>
                            <input type="number" min="1" max="99"
                                value={currentSession.matchDurationMin || DEFAULT_MATCH_MIN}
                                onChange={e => setMatchDuration(e.target.value)}
                                disabled={locked}
                            />
                            <span className="duration-unit">min</span>
                        </label>
                        <label className="duration-field">
                            <span>Timeout length</span>
                            <input type="number" min="1" max="10"
                                value={currentSession.timeoutDurationMin || DEFAULT_TIMEOUT_MIN}
                                onChange={e => setTimeoutDuration(e.target.value)}
                                disabled={locked}
                            />
                            <span className="duration-unit">min</span>
                        </label>
                        <p className="help-text duration-help">
                            {TIMEOUTS_PER_TEAM} timeouts per team per match.
                            {locked ? " Locked while the match is live." : " Lock in before you finalize."}
                        </p>
                    </div>
                    <div className="btn-row">
                        <button className="btn" onClick={copyTeamsText}>Copy for WhatsApp</button>
                        {!currentSession.teamsFinalized ? (
                            <button className="btn" onClick={finalizeTeams}>Finalize Teams · Go Live</button>
                        ) : (
                            <button className="btn btn-secondary" onClick={editTeams}>Edit Teams</button>
                        )}
                    </div>
                    {!currentSession.teamsFinalized && (
                        <p className="help-text">
                            Teams are a draft. Finalize to start the match and make it visible on the <strong>Live</strong> tab.
                        </p>
                    )}
                </div>
            )}

            {currentSession.teams && currentSession.teamsFinalized && (
                <Scoreboard
                    session={currentSession}
                    teams={currentSession.teams}
                    canEdit={true}
                    matchDurationMin={currentSession.matchDurationMin || DEFAULT_MATCH_MIN}
                    timeoutDurationMin={currentSession.timeoutDurationMin || DEFAULT_TIMEOUT_MIN}
                    onUpdate={(patch) => setCurrentSession({
                        ...currentSession,
                        scoreboard: { ...(currentSession.scoreboard || {}), ...patch },
                    })}
                    onEndMatch={(match) => setCurrentSession({
                        ...currentSession,
                        matches: [...(currentSession.matches || []), match],
                        scoreboard: {
                            ...(currentSession.scoreboard || {}),
                            scoreA: 0,
                            scoreB: 0,
                            timeoutsUsedA: 0,
                            timeoutsUsedB: 0,
                            timerRunning: false,
                            timerStartAt: null,
                            timerAccumMs: 0,
                            timeoutTeam: null,
                            timeoutStartAt: null,
                        },
                    })}
                    onSaveSession={lockAndSave}
                    showToast={showToast}
                />
            )}
        </div>
    );
}

function HistoryView({ sessions, members, deleteSession }) {
    const nameFor = (id) => members.find(m => m.id === id);
    const [expanded, setExpanded] = useState(null);
    const sorted = [...sessions].sort((a, b) => b.date.localeCompare(a.date));

    if (sorted.length === 0) {
        return (
            <div className="card">
                <div className="empty">No saved sessions yet.</div>
            </div>
        );
    }
    return (
        <div className="card">
            <h2>Past Sessions</h2>
            {sorted.map(s => (
                <div key={s.id}>
                    <div className="session-row" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                        <div className="session-date">{formatDate(s.date)}</div>
                        <div className="session-meta">
                            {s.available.length} players
                            {s.teams ? ` · ${s.teams.length} teams` : " · no teams"}
                            {Array.isArray(s.matches) && s.matches.length > 0 && ` · ${s.matches.length} match${s.matches.length === 1 ? "" : "es"}`}
                        </div>
                    </div>
                    {expanded === s.id && s.teams && (
                        <div style={{ padding: "0 0.5rem 1rem" }}>
                            <div className="teams-grid">
                                {s.teams.map((teamIds, i) => {
                                    const team = teamIds.map(id => nameFor(id)).filter(Boolean);
                                    return (
                                        <div key={i} className={`team team-${i + 1}`}>
                                            <div className="team-header">
                                                <div className="jersey">{String.fromCharCode(65 + i)}</div>
                                                <div className="team-title">
                                                    <span className="name">Team {String.fromCharCode(65 + i)}</span>
                                                    <span className="meta">{team.length} Players</span>
                                                </div>
                                            </div>
                                            <div className="team-players">
                                                {team.map(p => (
                                                    <div key={p.id} className="team-player" style={{ cursor: "default" }}>
                                                        <span>{p.name}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            {Array.isArray(s.matches) && s.matches.length > 0 && (
                                <>
                                    <h3 style={{ marginTop: "1rem" }}>Matches</h3>
                                    <div className="match-list">
                                        {s.matches.map((m, i) => (
                                            <MatchCard key={m.id || i} match={m} index={i} />
                                        ))}
                                    </div>
                                </>
                            )}
                            <div className="btn-row">
                                <button className="btn btn-danger" onClick={() => {
                                    if (confirm("Delete this session?")) deleteSession(s.id);
                                }}>Delete</button>
                            </div>
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}

function MatchView({ activeRoster, patchActive, showToast }) {
    const currentSession = activeRoster?.currentSession;
    const teams = currentSession?.teams;

    if (!currentSession || !teams) {
        return (
            <div className="card">
                <div className="empty">
                    No active match. Ask the admin to start a session and generate teams.
                </div>
            </div>
        );
    }

    if (!currentSession.teamsFinalized) {
        return (
            <div className="card">
                <div className="empty">
                    Teams aren't finalized yet. Scoring will open once the admin finalizes them.
                </div>
            </div>
        );
    }

    return (
        <Scoreboard
            session={currentSession}
            teams={teams}
            canEdit={true}
            matchDurationMin={currentSession.matchDurationMin || DEFAULT_MATCH_MIN}
            timeoutDurationMin={currentSession.timeoutDurationMin || DEFAULT_TIMEOUT_MIN}
            showToast={showToast}
            onUpdate={(patch) => patchActive(r => ({
                ...r,
                currentSession: {
                    ...r.currentSession,
                    scoreboard: { ...(r.currentSession?.scoreboard || {}), ...patch },
                },
            }))}
            onEndMatch={(match) => patchActive(r => ({
                ...r,
                currentSession: {
                    ...r.currentSession,
                    matches: [...(r.currentSession?.matches || []), match],
                    scoreboard: {
                        ...(r.currentSession?.scoreboard || {}),
                        scoreA: 0,
                        scoreB: 0,
                        timeoutsUsedA: 0,
                        timeoutsUsedB: 0,
                        timerRunning: false,
                        timerStartAt: null,
                        timerAccumMs: 0,
                        timeoutTeam: null,
                        timeoutStartAt: null,
                    },
                },
            }))}
        />
    );
}

function PublicMembersView({ members }) {
    const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name));
    return (
        <div className="card">
            <h2>Members ({sorted.length})</h2>
            {sorted.length === 0 ? (
                <div className="empty">No members yet.</div>
            ) : (
                <div className="member-list">
                    {sorted.map(m => (
                        <div className="member-row" key={m.id}>
                            <span className="member-name">{m.name}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function PublicHistoryView({ sessions, members }) {
    const nameFor = (id) => members.find(m => m.id === id);
    const [expanded, setExpanded] = useState(null);
    const sorted = [...sessions].sort((a, b) => b.date.localeCompare(a.date));

    if (sorted.length === 0) {
        return (
            <div className="card">
                <div className="empty">No saved sessions yet.</div>
            </div>
        );
    }
    return (
        <div className="card">
            <h2>Past Sessions</h2>
            {sorted.map(s => (
                <div key={s.id}>
                    <div className="session-row" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                        <div className="session-date">{formatDate(s.date)}</div>
                        <div className="session-meta">
                            {s.available.length} players
                            {s.teams ? ` · ${s.teams.length} teams` : " · no teams"}
                            {Array.isArray(s.matches) && s.matches.length > 0 && ` · ${s.matches.length} match${s.matches.length === 1 ? "" : "es"}`}
                        </div>
                    </div>
                    {expanded === s.id && s.teams && (
                        <div style={{ padding: "0 0.5rem 1rem" }}>
                            <div className="teams-grid">
                                {s.teams.map((teamIds, i) => {
                                    const team = teamIds.map(id => nameFor(id)).filter(Boolean);
                                    return (
                                        <div key={i} className={`team team-${i + 1}`}>
                                            <div className="team-header">
                                                <div className="jersey">{String.fromCharCode(65 + i)}</div>
                                                <div className="team-title">
                                                    <span className="name">Team {String.fromCharCode(65 + i)}</span>
                                                    <span className="meta">{team.length} Players</span>
                                                </div>
                                            </div>
                                            <div className="team-players">
                                                {team.map(p => (
                                                    <div key={p.id} className="team-player" style={{ cursor: "default" }}>
                                                        <span>{p.name}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            {Array.isArray(s.matches) && s.matches.length > 0 && (
                                <>
                                    <h3 style={{ marginTop: "1rem" }}>Matches</h3>
                                    <div className="match-list">
                                        {s.matches.map((m, i) => (
                                            <MatchCard key={m.id || i} match={m} index={i} />
                                        ))}
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}

function StandingsTable({ standings, teams }) {
    if (standings.length === 0) {
        return <div className="empty">No teams yet — add teams to see the standings.</div>;
    }
    return (
        <div className="standings-wrap">
            <table className="standings">
                <thead>
                    <tr>
                        <th className="pos">#</th>
                        <th className="team-col">Team</th>
                        <th>P</th>
                        <th>W</th>
                        <th>D</th>
                        <th>L</th>
                        <th>PF</th>
                        <th>PA</th>
                        <th className="pd-col">PD</th>
                        <th className="pts-col">Pts</th>
                    </tr>
                </thead>
                <tbody>
                    {standings.map((s, i) => {
                        const pd = s.pointsFor - s.pointsAgainst;
                        const originalIdx = teams.findIndex(t => t.id === s.team.id);
                        const color = teamColor(originalIdx >= 0 ? originalIdx : i);
                        return (
                            <tr key={s.team.id} className={i === 0 && s.played > 0 ? "leader" : ""}>
                                <td className="pos">{i + 1}</td>
                                <td className="team-col">
                                    <span className="team-dot" style={{ background: color }}></span>
                                    {s.team.name}
                                </td>
                                <td>{s.played}</td>
                                <td>{s.wins}</td>
                                <td>{s.draws}</td>
                                <td>{s.losses}</td>
                                <td>{s.pointsFor}</td>
                                <td>{s.pointsAgainst}</td>
                                <td className={`pd-col ${pd > 0 ? "pd-pos" : pd < 0 ? "pd-neg" : ""}`}>
                                    {pd > 0 ? `+${pd}` : pd}
                                </td>
                                <td className="pts-col">{s.pts}</td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            <div className="standings-legend">
                P played · W wins · D draws · L losses · PF for · PA against · PD diff · Pts = 2·W + D
            </div>
        </div>
    );
}

function TeamsManagerCard({ tournament, patchTournament, disabled, showToast }) {
    const [newTeamName, setNewTeamName] = useState("");
    const [editingTeamId, setEditingTeamId] = useState(null);
    const [editingName, setEditingName] = useState("");
    const [bulkText, setBulkText] = useState("");
    const [playerDrafts, setPlayerDrafts] = useState({});
    const [bulkPlayerDrafts, setBulkPlayerDrafts] = useState({});

    const addTeam = () => {
        if (disabled) return;
        const name = newTeamName.trim();
        if (!name) return;
        if (tournament.teams.some(t => t.name.toLowerCase() === name.toLowerCase())) {
            alert("A team with that name already exists.");
            return;
        }
        patchTournament(t => ({
            ...t,
            teams: [...(t.teams || []), { id: uid(), name, players: [] }],
        }));
        setNewTeamName("");
    };

    // Each line = one team. Format: "Team Name: Player1, Player2, ..." (players optional).
    const addTeamsBulk = () => {
        if (disabled) return;
        const lines = bulkText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (!lines.length) return;
        const existing = new Set(tournament.teams.map(t => t.name.toLowerCase()));
        const toAdd = [];
        lines.forEach(line => {
            const colon = line.indexOf(":");
            const teamName = (colon >= 0 ? line.slice(0, colon) : line).trim();
            if (!teamName) return;
            const key = teamName.toLowerCase();
            if (existing.has(key)) return;
            existing.add(key);
            const playerBlob = colon >= 0 ? line.slice(colon + 1) : "";
            const players = playerBlob
                .split(",").map(s => s.trim()).filter(Boolean);
            toAdd.push({ id: uid(), name: teamName, players });
        });
        if (!toAdd.length) {
            alert("No new teams to add — check for duplicates or empty names.");
            return;
        }
        patchTournament(t => ({ ...t, teams: [...(t.teams || []), ...toAdd] }));
        setBulkText("");
        showToast?.(`Added ${toAdd.length} team${toAdd.length === 1 ? "" : "s"}`);
    };

    const commitRename = (teamId) => {
        const name = editingName.trim();
        setEditingTeamId(null);
        if (!name) return;
        const existing = tournament.teams.find(t => t.id === teamId);
        if (!existing || name === existing.name) return;
        if (tournament.teams.some(t => t.id !== teamId && t.name.toLowerCase() === name.toLowerCase())) {
            alert("A team with that name already exists.");
            return;
        }
        patchTournament(t => ({
            ...t,
            teams: t.teams.map(x => x.id === teamId ? { ...x, name } : x),
        }));
    };

    const deleteTeam = (teamId) => {
        if (disabled) return;
        const team = tournament.teams.find(t => t.id === teamId);
        if (!team) return;
        const hasMatches = (tournament.matches || []).some(m => m.teamAId === teamId || m.teamBId === teamId);
        if (hasMatches) {
            if (!confirm(`"${team.name}" has recorded matches. Delete the team AND its matches?`)) return;
            patchTournament(t => ({
                ...t,
                teams: t.teams.filter(x => x.id !== teamId),
                matches: (t.matches || []).filter(m => m.teamAId !== teamId && m.teamBId !== teamId),
            }));
        } else {
            if (!confirm(`Delete team "${team.name}"?`)) return;
            patchTournament(t => ({
                ...t,
                teams: t.teams.filter(x => x.id !== teamId),
            }));
        }
    };

    const addPlayer = (teamId) => {
        if (disabled) return;
        const name = (playerDrafts[teamId] || "").trim();
        if (!name) return;
        patchTournament(t => ({
            ...t,
            teams: t.teams.map(x => x.id === teamId ? {
                ...x,
                players: x.players.includes(name) ? x.players : [...x.players, name],
            } : x),
        }));
        setPlayerDrafts(d => ({ ...d, [teamId]: "" }));
    };

    const bulkAddPlayers = (teamId) => {
        if (disabled) return;
        const text = (bulkPlayerDrafts[teamId] || "").trim();
        if (!text) return;
        const names = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (!names.length) return;
        patchTournament(t => ({
            ...t,
            teams: t.teams.map(x => x.id === teamId ? {
                ...x,
                players: [...x.players, ...names.filter(n => !x.players.includes(n))],
            } : x),
        }));
        setBulkPlayerDrafts(d => ({ ...d, [teamId]: "" }));
    };

    const removePlayer = (teamId, playerName) => {
        if (disabled) return;
        patchTournament(t => ({
            ...t,
            teams: t.teams.map(x => x.id === teamId ? {
                ...x,
                players: x.players.filter(p => p !== playerName),
            } : x),
        }));
    };

    return (
        <div className="card">
            <h2>Teams</h2>
            <div className="row" style={{ marginBottom: "0.5rem" }}>
                <input
                    type="text"
                    placeholder="Team name (e.g. Sharks)"
                    value={newTeamName}
                    onChange={e => setNewTeamName(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && addTeam()}
                    disabled={disabled}
                />
                <button className="btn" onClick={addTeam} disabled={disabled}>Add Team</button>
            </div>
            <details className="bulk-teams-details">
                <summary>Paste multiple teams at once</summary>
                <div className="bulk-paste">
                    <p className="help-text" style={{ marginTop: 0 }}>
                        One team per line. Format: <code>Team Name: Player1, Player2, Player3</code>.
                        Players are optional and can be added later.
                    </p>
                    <textarea
                        value={bulkText}
                        onChange={e => setBulkText(e.target.value)}
                        placeholder={"Sharks: Alice, Bob, Carol\nWolves: Dave, Eve\nFoxes"}
                        rows={5}
                        disabled={disabled}
                    />
                    <button className="btn" onClick={addTeamsBulk} disabled={disabled}>Add teams</button>
                </div>
            </details>
            {tournament.teams.length === 0 ? (
                <div className="empty">No teams yet. Add one above or paste multiple at once.</div>
            ) : (
                <div className="tournament-teams">
                    {tournament.teams.map((team, idx) => {
                        const color = teamColor(idx);
                        return (
                            <div key={team.id} className="t-team" style={{ borderLeftColor: color }}>
                                <div className="t-team-header">
                                    {editingTeamId === team.id ? (
                                        <input
                                            className="t-team-name-input"
                                            autoFocus
                                            value={editingName}
                                            onChange={e => setEditingName(e.target.value)}
                                            onBlur={() => commitRename(team.id)}
                                            onKeyDown={e => {
                                                if (e.key === "Enter") commitRename(team.id);
                                                if (e.key === "Escape") setEditingTeamId(null);
                                            }}
                                        />
                                    ) : (
                                        <span
                                            className="t-team-name"
                                            style={{ color }}
                                            onClick={() => { if (!disabled) { setEditingTeamId(team.id); setEditingName(team.name); } }}
                                            title={disabled ? "" : "Click to rename"}
                                        >
                                            {team.name}
                                            <span className="t-team-count"> · {team.players.length}</span>
                                        </span>
                                    )}
                                    <button className="icon-btn" onClick={() => deleteTeam(team.id)} title="Delete team" disabled={disabled}>✕</button>
                                </div>
                                {team.players.length > 0 && (
                                    <div className="t-team-chips">
                                        {team.players.map(p => (
                                            <span key={p} className="t-chip">
                                                {p}
                                                {!disabled && (
                                                    <button
                                                        className="t-chip-x"
                                                        onClick={() => removePlayer(team.id, p)}
                                                        title={`Remove ${p}`}
                                                        aria-label={`Remove ${p}`}
                                                    >×</button>
                                                )}
                                            </span>
                                        ))}
                                    </div>
                                )}
                                <div className="row t-add-player">
                                    <input
                                        type="text"
                                        placeholder="Add player name"
                                        value={playerDrafts[team.id] || ""}
                                        onChange={e => setPlayerDrafts(d => ({ ...d, [team.id]: e.target.value }))}
                                        onKeyDown={e => e.key === "Enter" && addPlayer(team.id)}
                                        disabled={disabled}
                                    />
                                    <button className="btn btn-secondary" onClick={() => addPlayer(team.id)} disabled={disabled}>Add</button>
                                </div>
                                <details className="t-bulk-players">
                                    <summary>Paste players (one per line)</summary>
                                    <textarea
                                        value={bulkPlayerDrafts[team.id] || ""}
                                        onChange={e => setBulkPlayerDrafts(d => ({ ...d, [team.id]: e.target.value }))}
                                        rows={4}
                                        placeholder={"Alice\nBob\nCarol"}
                                        disabled={disabled}
                                    />
                                    <button className="btn btn-secondary" onClick={() => bulkAddPlayers(team.id)} disabled={disabled}>Add players</button>
                                </details>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// Roster-kind tournament setup: pool of players with categories + ranks,
// availability toggles, and an AI "Generate Teams" step that creates
// tournament.teams out of the available players.
// Teams tab for a roster-kind tournament. Shows the generated teams (same for
// admin and non-admin), plus the past-rounds history. For admins without
// recorded matches yet, player drag/tap-to-move is enabled.
function RosterTeamsCard({ tournament, patchTournament, disabled }) {
    const teams = tournament.teams || [];
    const matches = tournament.matches || [];
    const rounds = tournament.rounds || [];
    const hasMatches = matches.length > 0;
    const canEdit = !disabled;
    const canMovePlayers = canEdit && !hasMatches;
    const finalized = tournament.teamsFinalized !== false;
    const toggleFinalize = () => {
        if (!canEdit) return;
        if (finalized) {
            if (!confirm("Edit teams again? They'll be hidden from viewers until you re-publish.")) return;
            patchTournament(t => ({ ...t, teamsFinalized: false }));
        } else {
            patchTournament(t => ({ ...t, teamsFinalized: true }));
        }
    };

    const [selectedPlayer, setSelectedPlayer] = useState(null);
    const [dragOverTeam, setDragOverTeam] = useState(null);
    const [expandedRoundId, setExpandedRoundId] = useState(null);

    const movePlayerTo = (playerName, fromTeamIdx, toTeamIdx, toIdx) => {
        if (!canMovePlayers) return;
        patchTournament(t => {
            const list = t.teams || [];
            const next = list.map(team => ({ ...team, players: [...team.players] }));
            if (!next[fromTeamIdx] || !next[toTeamIdx]) return t;
            const srcIdx = next[fromTeamIdx].players.indexOf(playerName);
            if (srcIdx === -1) return t;
            next[fromTeamIdx].players.splice(srcIdx, 1);
            let insertAt = toIdx == null ? next[toTeamIdx].players.length : toIdx;
            if (fromTeamIdx === toTeamIdx && srcIdx < insertAt) insertAt -= 1;
            next[toTeamIdx].players.splice(insertAt, 0, playerName);
            return { ...t, teams: next };
        });
        setSelectedPlayer(null);
    };

    const swapPlayers = (p1, t1, p2, t2) => {
        if (!canMovePlayers) return;
        if (p1 === p2 && t1 === t2) { setSelectedPlayer(null); return; }
        patchTournament(t => {
            const list = t.teams || [];
            const next = list.map(team => ({ ...team, players: [...team.players] }));
            if (!next[t1] || !next[t2]) return t;
            const i1 = next[t1].players.indexOf(p1);
            const i2 = next[t2].players.indexOf(p2);
            if (i1 === -1 || i2 === -1) return t;
            next[t1].players[i1] = p2;
            next[t2].players[i2] = p1;
            return { ...t, teams: next };
        });
        setSelectedPlayer(null);
    };

    const handlePlayerTap = (playerName, teamIdx) => {
        if (!canMovePlayers) return;
        if (selectedPlayer?.playerName === playerName && selectedPlayer?.fromTeamIdx === teamIdx) {
            setSelectedPlayer(null);
        } else if (selectedPlayer) {
            swapPlayers(selectedPlayer.playerName, selectedPlayer.fromTeamIdx, playerName, teamIdx);
        } else {
            setSelectedPlayer({ playerName, fromTeamIdx: teamIdx });
        }
    };

    const handleTeamTap = (teamIdx) => {
        if (!canMovePlayers) return;
        if (selectedPlayer) movePlayerTo(selectedPlayer.playerName, selectedPlayer.fromTeamIdx, teamIdx, null);
    };

    // Non-admin viewer with teams that haven't been published yet: show a
    // waiting placeholder instead of the draft teams.
    if (!canEdit && teams.length > 0 && !finalized) {
        return (
            <div className="card">
                <h2>Teams</h2>
                <div className="empty">
                    Admin is finalizing the teams. They'll appear here once published.
                </div>
            </div>
        );
    }

    return (
        <>
            <div className="card">
                <h2>Teams{canEdit && teams.length > 0 && !finalized && <span className="draft-badge" title="Only you can see these teams until you publish">Draft</span>}</h2>
                {teams.length === 0 ? (
                    <div className="empty">
                        {canEdit
                            ? "No teams yet. Mark players available in the Roster tab and tap Generate Teams."
                            : "No teams yet. Teams will appear here once the admin generates them."}
                    </div>
                ) : (
                    <>
                        {canMovePlayers && selectedPlayer && (
                            <div className="move-hint">
                                <strong>{selectedPlayer.playerName}</strong> picked up — tap another player to swap, tap another team card to move to its end, or tap <strong>{selectedPlayer.playerName}</strong> again to cancel.
                            </div>
                        )}
                        <div className="teams-grid">
                            {teams.map((team, i) => {
                                const droppable = canMovePlayers && selectedPlayer != null && selectedPlayer.fromTeamIdx !== i;
                                const dragOver = canMovePlayers && dragOverTeam === i;
                                const teamHandlers = canMovePlayers ? {
                                    onClick: () => handleTeamTap(i),
                                    onDragOver: e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragOverTeam !== i) setDragOverTeam(i); },
                                    onDragLeave: e => {
                                        if (!e.currentTarget.contains(e.relatedTarget)) setDragOverTeam(null);
                                    },
                                    onDrop: e => {
                                        e.preventDefault();
                                        setDragOverTeam(null);
                                        try {
                                            const data = JSON.parse(e.dataTransfer.getData("application/json"));
                                            movePlayerTo(data.playerName, data.fromTeamIdx, i, null);
                                        } catch {}
                                    },
                                } : {};
                                return (
                                    <div
                                        key={team.id}
                                        className={`team team-${i + 1} ${droppable ? "droppable" : ""} ${dragOver ? "drag-over" : ""} ${canMovePlayers ? "" : "locked"}`}
                                        {...teamHandlers}
                                    >
                                        <div className="team-header">
                                            <div className="jersey">{String.fromCharCode(65 + i)}</div>
                                            <div className="team-title">
                                                <span className="name">{team.name}</span>
                                                <span className="meta">{team.players.length} Players</span>
                                            </div>
                                        </div>
                                        <div className="team-players">
                                            {team.players.map((p, playerIdx) => {
                                                const isSelected = selectedPlayer?.playerName === p && selectedPlayer?.fromTeamIdx === i;
                                                const playerHandlers = canMovePlayers ? {
                                                    draggable: true,
                                                    onDragStart: e => {
                                                        e.dataTransfer.setData("application/json", JSON.stringify({ playerName: p, fromTeamIdx: i }));
                                                        e.dataTransfer.effectAllowed = "move";
                                                        e.currentTarget.classList.add("dragging");
                                                    },
                                                    onDragEnd: e => {
                                                        e.currentTarget.classList.remove("dragging");
                                                        e.currentTarget.classList.remove("drop-before", "drop-after");
                                                        setDragOverTeam(null);
                                                    },
                                                    onDragOver: e => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        e.dataTransfer.dropEffect = "move";
                                                        const rect = e.currentTarget.getBoundingClientRect();
                                                        const after = (e.clientY - rect.top) > rect.height / 2;
                                                        e.currentTarget.classList.toggle("drop-before", !after);
                                                        e.currentTarget.classList.toggle("drop-after", after);
                                                        if (dragOverTeam !== i) setDragOverTeam(i);
                                                    },
                                                    onDragLeave: e => {
                                                        e.currentTarget.classList.remove("drop-before", "drop-after");
                                                    },
                                                    onDrop: e => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        const rect = e.currentTarget.getBoundingClientRect();
                                                        const after = (e.clientY - rect.top) > rect.height / 2;
                                                        e.currentTarget.classList.remove("drop-before", "drop-after");
                                                        setDragOverTeam(null);
                                                        try {
                                                            const data = JSON.parse(e.dataTransfer.getData("application/json"));
                                                            movePlayerTo(data.playerName, data.fromTeamIdx, i, playerIdx + (after ? 1 : 0));
                                                        } catch {}
                                                    },
                                                    onClick: e => { e.stopPropagation(); handlePlayerTap(p, i); },
                                                } : {};
                                                return (
                                                    <div
                                                        key={`${i}-${playerIdx}-${p}`}
                                                        className={`team-player ${isSelected ? "selected" : ""}`}
                                                        style={canMovePlayers ? undefined : { cursor: "default" }}
                                                        {...playerHandlers}
                                                    >
                                                        <span>{p}</span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        {canMovePlayers ? (
                            <p className="help-text">
                                Drag a player onto another player to place them at that exact spot (works within the same team too). Drop on empty team space to add to the end. On mobile: tap a player, then tap another player to swap, or tap a team card to move to its end.
                            </p>
                        ) : hasMatches && canEdit ? (
                            <p className="help-text">Teams are locked because matches have been recorded. Start a new round from the Roster tab to reshuffle.</p>
                        ) : null}
                        {canEdit && (
                            <div className="btn-row">
                                {!finalized ? (
                                    <button className="btn" onClick={toggleFinalize}>
                                        Finalize teams · Publish
                                    </button>
                                ) : (
                                    <button className="btn btn-secondary" onClick={toggleFinalize}>
                                        Edit teams (unpublish)
                                    </button>
                                )}
                            </div>
                        )}
                        {canEdit && !finalized && (
                            <p className="help-text">Only you can see these teams. Tap <strong>Finalize teams · Publish</strong> to make them visible to everyone.</p>
                        )}
                    </>
                )}
            </div>

            {rounds.length > 0 && (
                <div className="card">
                    <h2>Past Rounds ({rounds.length})</h2>
                    <div className="history-list">
                        {[...rounds].reverse().map(round => {
                            const standings = computeStandings(round.teams, round.matches);
                            const winner = standings[0]?.played > 0 ? standings[0].team : null;
                            const expanded = expandedRoundId === round.id;
                            return (
                                <div key={round.id}>
                                    <div
                                        className="history-row"
                                        onClick={() => setExpandedRoundId(expanded ? null : round.id)}
                                    >
                                        <div className="history-name">{formatDate(round.date)}</div>
                                        <div className="history-meta">
                                            {round.teams.length} teams · {round.matches.length} match{round.matches.length === 1 ? "" : "es"}
                                        </div>
                                        <div className="history-winner">
                                            {winner ? <>🏆 <strong>{winner.name}</strong></> : <span className="muted">No winner</span>}
                                        </div>
                                    </div>
                                    {expanded && (
                                        <div style={{ padding: "0.5rem 0 1rem" }}>
                                            {canEdit && (
                                                <div className="btn-row" style={{ marginBottom: "0.75rem" }}>
                                                    <button
                                                        className="btn btn-danger"
                                                        onClick={() => {
                                                            if (!confirm("Delete this round's history?")) return;
                                                            patchTournament(t => ({
                                                                ...t,
                                                                rounds: (t.rounds || []).filter(r => r.id !== round.id),
                                                            }));
                                                            setExpandedRoundId(null);
                                                        }}
                                                    >Delete this round</button>
                                                </div>
                                            )}
                                            <StandingsTable standings={standings} teams={round.teams} />
                                            {round.matches.length > 0 && (
                                                <>
                                                    <h3 style={{ marginTop: "1rem" }}>Matches</h3>
                                                    <div className="match-list">
                                                        {[...round.matches].reverse().map((m, i) => (
                                                            <TournamentMatchCard
                                                                key={m.id || i}
                                                                match={m}
                                                                teams={round.teams}
                                                                index={round.matches.length - 1 - i}
                                                            />
                                                        ))}
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </>
    );
}

function RosterTournamentCard({ tournament, patchTournament, disabled, showToast, rosterTemplates, setRosterTemplates }) {
    const members = tournament.rosterMembers || [];
    const availableIds = tournament.availableIds || [];
    const teams = tournament.teams || [];
    const hasMatches = (tournament.matches || []).length > 0;
    const canEdit = !disabled;
    const canManageTemplates = typeof setRosterTemplates === "function";
    const templates = rosterTemplates || [];

    const [name, setName] = useState("");
    const [category, setCategory] = useState(3);
    const [filter, setFilter] = useState("all");
    // Saved template id to seed/replace from (null when no templates exist).
    const [seedChoice, setSeedChoice] = useState(templates[0]?.id || "");

    // Non-admin view: alphabetical roster names only. The Teams tab is where
    // generated teams and past rounds show up for everyone.
    if (!canEdit) {
        const alphabetical = [...members].sort((a, b) => a.name.localeCompare(b.name));
        return (
            <div className="card">
                <h2>Roster ({members.length})</h2>
                {members.length === 0 ? (
                    <div className="empty">No players yet.</div>
                ) : (
                    <div className="member-list">
                        {alphabetical.map(m => (
                            <div key={m.id} className="member-row">
                                <span className="member-name">{m.name}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    const addMember = () => {
        if (!canEdit) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        if (members.some(m => m.name.toLowerCase() === trimmed.toLowerCase())) {
            alert("A player with that name is already in the roster.");
            return;
        }
        const nextRank = Math.max(0, ...members.filter(m => m.category === category).map(m => m.rank || 0)) + 1;
        const newMember = { id: uid(), name: trimmed, category, rank: nextRank };
        patchTournament(t => ({
            ...t,
            rosterMembers: [...(t.rosterMembers || []), newMember],
            availableIds: [...(t.availableIds || []), newMember.id],
        }));
        setName("");
    };

    const updateMember = (id, field, value) => {
        if (!canEdit) return;
        patchTournament(t => ({
            ...t,
            rosterMembers: (t.rosterMembers || []).map(m => m.id === id ? { ...m, [field]: value } : m),
        }));
    };

    const removeMember = (id) => {
        if (!canEdit) return;
        const m = members.find(x => x.id === id);
        if (!m) return;
        if (!confirm(`Remove ${m.name} from the roster?`)) return;
        patchTournament(t => ({
            ...t,
            rosterMembers: (t.rosterMembers || []).filter(x => x.id !== id),
            availableIds: (t.availableIds || []).filter(x => x !== id),
        }));
    };

    const toggleOut = (id) => {
        if (!canEdit) return;
        patchTournament(t => {
            const current = t.availableIds || [];
            const next = current.includes(id) ? current.filter(x => x !== id) : [...current, id];
            return { ...t, availableIds: next };
        });
    };

    const markAllIn = () => {
        if (!canEdit) return;
        patchTournament(t => ({ ...t, availableIds: (t.rosterMembers || []).map(m => m.id) }));
    };

    const markAllOut = () => {
        if (!canEdit) return;
        patchTournament(t => ({ ...t, availableIds: [] }));
    };

    // Load a saved template into the current tournament's roster. New ids keep
    // the loaded members independent from the template (and from any past-round
    // player ids inside the tournament).
    const seedFromChoice = (choice) => {
        if (!canEdit) return;
        const tpl = templates.find(x => x.id === choice);
        if (!tpl) return;
        const source = tpl.members.map(m => ({
            id: uid(),
            name: m.name,
            category: m.category,
            rank: m.rank,
        }));
        const label = `"${tpl.name}"`;
        if (members.length > 0 && !confirm(`Replace the current roster with ${label}?`)) return;
        patchTournament(t => ({
            ...t,
            rosterMembers: source,
            availableIds: source.map(m => m.id),
        }));
        showToast?.(`Loaded ${label}`);
    };

    const saveAsTemplate = () => {
        if (!canManageTemplates) return;
        if (members.length === 0) {
            alert("Add at least one player before saving a template.");
            return;
        }
        const suggested = tournament.name || "My roster";
        const name = (prompt("Save roster template as:", suggested) || "").trim();
        if (!name) return;
        const existing = templates.find(x => x.name.toLowerCase() === name.toLowerCase());
        if (existing && !confirm(`"${name}" already exists. Overwrite it?`)) return;
        // Snapshot current members with fresh ids so template is independent.
        const snapshot = members.map(m => ({
            id: uid(),
            name: m.name,
            category: m.category,
            rank: m.rank,
        }));
        setRosterTemplates(prev => {
            const list = prev || [];
            if (existing) {
                return list.map(x => x.id === existing.id ? { ...x, members: snapshot } : x);
            }
            return [...list, { id: uid(), name, members: snapshot }];
        });
        showToast?.(`Saved "${name}"`);
    };

    const deleteTemplate = (templateId) => {
        if (!canManageTemplates) return;
        const tpl = templates.find(x => x.id === templateId);
        if (!tpl) return;
        if (!confirm(`Delete saved roster "${tpl.name}"?`)) return;
        setRosterTemplates(prev => (prev || []).filter(x => x.id !== templateId));
        if (seedChoice === templateId) {
            const remaining = templates.filter(x => x.id !== templateId);
            setSeedChoice(remaining[0]?.id || "");
        }
        showToast?.(`Deleted "${tpl.name}"`);
    };

    const generateTeams = () => {
        if (!canEdit) return;
        const available = members.filter(m => availableIds.includes(m.id));
        if (available.length < 3) return;
        // Reshuffling after matches have been recorded = starting a new round.
        // Archive the current teams + matches so they are not lost.
        if (hasMatches) {
            if (!confirm("Start a new round? The current round's matches will be moved to Past Rounds.")) return;
        }
        const numTeams = available.length >= 17 ? 3 : 2;
        const teamArrays = generateBalancedTeams(available, numTeams);
        const generated = teamArrays.map((team, i) => ({
            id: uid(),
            name: `Team ${String.fromCharCode(65 + i)}`,
            players: team.map(p => p.name),
        }));
        patchTournament(t => {
            const nextRounds = (t.matches || []).length > 0
                ? [...(t.rounds || []), {
                    id: uid(),
                    date: t.date || todayISO(),
                    teams: t.teams || [],
                    matches: t.matches || [],
                }]
                : (t.rounds || []);
            return {
                ...t,
                date: todayISO(),
                rounds: nextRounds,
                teams: generated,
                matches: [],
                activeMatches: {},
                teamsFinalized: false,
            };
        });
        showToast?.(hasMatches ? "New round started" : `${numTeams} teams generated`);
    };

    const grouped = { 1: [], 2: [], 3: [] };
    members.forEach(m => { grouped[m.category || 3].push(m); });
    Object.values(grouped).forEach(list => list.sort((a, b) => (a.rank || 999) - (b.rank || 999)));

    const availablePlayers = members.filter(m => availableIds.includes(m.id));
    const breakdown = { 1: 0, 2: 0, 3: 0 };
    availablePlayers.forEach(p => breakdown[p.category || 3]++);

    const visible = members
        .filter(m => filter === "all" || m.category === Number(filter))
        .sort((a, b) => {
            if (a.category !== b.category) return a.category - b.category;
            return (a.rank || 999) - (b.rank || 999);
        });

    return (
        <>
            {canEdit && (
                <div className="card">
                    <h2>Add Player</h2>
                    <div className="row">
                        <input
                            type="text"
                            value={name}
                            placeholder="Player name"
                            onChange={e => setName(e.target.value)}
                            onKeyDown={e => e.key === "Enter" && addMember()}
                        />
                        <select value={category} onChange={e => setCategory(Number(e.target.value))}>
                            <option value={1}>Category 1</option>
                            <option value={2}>Category 2</option>
                            <option value={3}>Category 3</option>
                        </select>
                        <button className="btn" onClick={addMember}>Add</button>
                    </div>
                    {members.length === 0 && (
                        <div className="roster-seed">
                            {templates.length > 0 ? (
                                <>
                                    <label className="roster-seed-label">Or load a saved roster:</label>
                                    <div className="row">
                                        <select
                                            value={seedChoice}
                                            onChange={e => setSeedChoice(e.target.value)}
                                        >
                                            {templates.map(tpl => (
                                                <option key={tpl.id} value={tpl.id}>
                                                    {tpl.name} ({tpl.members.length})
                                                </option>
                                            ))}
                                        </select>
                                        <button className="btn btn-secondary" onClick={() => seedFromChoice(seedChoice)}>Load</button>
                                    </div>
                                </>
                            ) : (
                                <p className="help-text" style={{ marginTop: 0 }}>
                                    Add players above. Once you have a roster you like, use <strong>💾 Save as template</strong> to reuse it for future tournaments.
                                </p>
                            )}
                        </div>
                    )}
                </div>
            )}

            <div className="card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem", flexWrap: "wrap", gap: "0.5rem" }}>
                    <h2 style={{ margin: 0 }}>Roster ({members.length})</h2>
                    {canEdit && members.length > 0 && (
                        <div className="roster-tool-row">
                            {canManageTemplates && (
                                <button className="btn btn-secondary" onClick={saveAsTemplate} title="Save this roster as a reusable template">
                                    💾 Save as template
                                </button>
                            )}
                            {templates.length > 0 && (
                                <>
                                    <select
                                        value={seedChoice}
                                        onChange={e => setSeedChoice(e.target.value)}
                                        title="Pick a saved roster to replace with"
                                    >
                                        {templates.map(tpl => (
                                            <option key={tpl.id} value={tpl.id}>
                                                {tpl.name} ({tpl.members.length})
                                            </option>
                                        ))}
                                    </select>
                                    <button className="btn btn-secondary" onClick={() => seedFromChoice(seedChoice)}>Replace</button>
                                    {canManageTemplates && seedChoice && (
                                        <button
                                            className="btn btn-secondary danger"
                                            onClick={() => deleteTemplate(seedChoice)}
                                            title="Delete the selected saved roster"
                                        >Delete saved</button>
                                    )}
                                </>
                            )}
                        </div>
                    )}
                </div>

                {members.length === 0 ? (
                    <div className="empty">No players yet. Add players above or seed the preset roster.</div>
                ) : (
                    <>
                        <div className="stats-bar">
                            <div className="stat"><div className="num">{availablePlayers.length}</div><div className="label">In</div></div>
                            <div className="stat c1"><div className="num">{breakdown[1]}</div><div className="label">Cat 1</div></div>
                            <div className="stat c2"><div className="num">{breakdown[2]}</div><div className="label">Cat 2</div></div>
                            <div className="stat c3"><div className="num">{breakdown[3]}</div><div className="label">Cat 3</div></div>
                            <div className="stat danger"><div className="num">{members.length - availablePlayers.length}</div><div className="label">Out</div></div>
                        </div>

                        <div className="filter-bar">
                            {["all", "1", "2", "3"].map(f => (
                                <button
                                    key={f}
                                    className={`filter-btn ${filter === f ? "active" : ""}`}
                                    onClick={() => setFilter(f)}
                                >
                                    {f === "all" ? "All" : `Category ${f}`}
                                </button>
                            ))}
                            {canEdit && <button className="filter-btn" onClick={markAllIn}>Everyone in</button>}
                            {canEdit && <button className="filter-btn" onClick={markAllOut}>Everyone out</button>}
                        </div>

                        {canEdit && <h3>Tap players who are NOT playing</h3>}
                        <div className="member-list">
                            {visible.map(m => {
                                const isOut = !availableIds.includes(m.id);
                                return (
                                    <div
                                        key={m.id}
                                        className={`member-row ${canEdit ? "selectable" : ""} ${isOut ? "out" : ""}`}
                                        onClick={canEdit ? () => toggleOut(m.id) : undefined}
                                    >
                                        {canEdit && <div className="checkbox">{isOut && "✕"}</div>}
                                        <span className="member-name">{m.name}</span>
                                        <CatBadge category={m.category} rank={m.rank} />
                                        {canEdit && (
                                            <>
                                                <select
                                                    value={m.category}
                                                    onChange={e => { e.stopPropagation(); updateMember(m.id, "category", Number(e.target.value)); }}
                                                    onClick={e => e.stopPropagation()}
                                                    style={{ minWidth: "90px" }}
                                                >
                                                    <option value={1}>Cat 1</option>
                                                    <option value={2}>Cat 2</option>
                                                    <option value={3}>Cat 3</option>
                                                </select>
                                                <button
                                                    className="icon-btn"
                                                    onClick={e => { e.stopPropagation(); removeMember(m.id); }}
                                                    title="Remove from roster"
                                                >✕</button>
                                            </>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        {canEdit && (
                            <div className="btn-row">
                                <button
                                    className="btn"
                                    onClick={generateTeams}
                                    disabled={availablePlayers.length < 3}
                                >
                                    {hasMatches
                                        ? "Start new round · Reshuffle"
                                        : (teams.length > 0 ? "Reshuffle Teams" : "Generate Teams")}
                                </button>
                            </div>
                        )}
                        {canEdit && availablePlayers.length < 3 && (
                            <p className="help-text">Need at least 3 available players to form teams.</p>
                        )}
                        {canEdit && hasMatches && (
                            <p className="help-text">The current round has matches. Reshuffling will archive them to <strong>Past Rounds</strong> and start a fresh round with the same roster.</p>
                        )}
                    </>
                )}
            </div>

        </>
    );
}

function TournamentScoreboard({ tournament, patchTournament, showToast, scorerKey }) {
    const teams = tournament.teams || [];

    if (teams.length < 2) {
        return (
            <div className="card">
                <h2>Record Match</h2>
                <div className="empty">Add at least two teams to start recording matches.</div>
            </div>
        );
    }

    // Roster-kind: can't start scoring until the admin has finalized the teams,
    // otherwise viewers would see a live match whose teams are still a draft.
    if (tournament.kind === TOURNAMENT_KIND_ROSTER && tournament.teamsFinalized === false) {
        return (
            <div className="card">
                <h2>Record Match</h2>
                <div className="empty">
                    Finalize the teams first (Teams tab → <strong>Finalize teams · Publish</strong>). Matches can't start on draft teams.
                </div>
            </div>
        );
    }

    const slotKey = scorerKey || "default";
    const am = (tournament.activeMatches && tournament.activeMatches[slotKey]) || {};
    let teamAId = am.teamAId;
    let teamBId = am.teamBId;
    if (!teams.find(t => t.id === teamAId)) teamAId = teams[0].id;
    if (!teams.find(t => t.id === teamBId) || teamBId === teamAId) {
        teamBId = teams.find(t => t.id !== teamAId)?.id;
    }
    const scoreA = am.scoreA || 0;
    const scoreB = am.scoreB || 0;
    const timeoutsUsedA = am.timeoutsUsedA || 0;
    const timeoutsUsedB = am.timeoutsUsedB || 0;

    const matchDurationMin = tournament.matchDurationMin || DEFAULT_MATCH_MIN;
    const timeoutDurationMin = tournament.timeoutDurationMin || DEFAULT_TIMEOUT_MIN;

    const [now, setNow] = useState(() => Date.now());
    const alarmFiredRef = useRef(false);
    const toAlarmFiredRef = useRef(false);

    const running = !!am.timerRunning;
    const timeoutTeam = am.timeoutTeam || null;

    useEffect(() => {
        if (!running && !timeoutTeam) return;
        setNow(Date.now());
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [running, timeoutTeam]);

    const match = computeMatchTime(am, matchDurationMin, now);
    const timeoutT = computeTimeoutTime(am, timeoutDurationMin, now);
    const elapsedSec = match.elapsedSec;
    const remaining = match.remainingSec;
    const mm = Math.floor(remaining / 60);
    const ss = remaining % 60;
    const expired = match.expired;
    const timerNotStarted = !running && elapsedSec === 0 && !timeoutTeam;
    const timerPaused = !running && elapsedSec > 0 && !expired && !timeoutTeam;
    const toMM = Math.floor(timeoutT.remainingSec / 60);
    const toSS = timeoutT.remainingSec % 60;

    // Always seed teamAId/teamBId so the Live view can pick this slot up as
    // soon as the scorer starts the timer (not just when they bump a score).
    // Existing stored ids take precedence over the local defaults; the explicit
    // `patch` wins over both.
    const setActive = (patch) => patchTournament(t => ({
        ...t,
        activeMatches: {
            ...(t.activeMatches || {}),
            [slotKey]: {
                teamAId,
                teamBId,
                ...((t.activeMatches && t.activeMatches[slotKey]) || {}),
                ...patch,
            },
        },
    }));

    useEffect(() => {
        if (!running || !expired) {
            if (!running && elapsedSec === 0) alarmFiredRef.current = false;
            return;
        }
        if (alarmFiredRef.current) return;
        alarmFiredRef.current = true;
        playTimerAlarm();
        setActive({
            timerRunning: false,
            timerStartAt: null,
            timerAccumMs: match.durationSec * 1000,
        });
    }, [running, expired, elapsedSec]);

    useEffect(() => {
        if (!timeoutTeam) { toAlarmFiredRef.current = false; return; }
        if (!timeoutT.expired) return;
        if (toAlarmFiredRef.current) return;
        toAlarmFiredRef.current = true;
        playTimerAlarm();
        setActive({
            timeoutTeam: null,
            timeoutStartAt: null,
            timerRunning: true,
            timerStartAt: Date.now(),
        });
    }, [timeoutTeam, timeoutT.expired]);

    const pickTeam = (which, newId) => {
        const reset = {
            scoreA: 0, scoreB: 0, timeoutsUsedA: 0, timeoutsUsedB: 0,
            timerRunning: false, timerStartAt: null, timerAccumMs: 0,
            timeoutTeam: null, timeoutStartAt: null,
        };
        if (which === "A") {
            const nextB = newId === teamBId ? teamAId : teamBId;
            setActive({ teamAId: newId, teamBId: nextB, ...reset });
        } else {
            const nextA = newId === teamAId ? teamBId : teamAId;
            setActive({ teamAId: nextA, teamBId: newId, ...reset });
        }
    };

    const bump = (which, delta) => {
        if (which === "A") setActive({ scoreA: Math.max(0, scoreA + delta), teamAId, teamBId });
        else setActive({ scoreB: Math.max(0, scoreB + delta), teamAId, teamBId });
    };

    const resetScores = () => {
        if (!confirm("Reset both scores to 0?")) return;
        setActive({ scoreA: 0, scoreB: 0, teamAId, teamBId });
    };

    const toggleTimer = () => {
        if (running) {
            setActive({
                timerRunning: false,
                timerStartAt: null,
                timerAccumMs: match.elapsedMs,
            });
        } else {
            setActive({
                timerRunning: true,
                timerStartAt: Date.now(),
            });
        }
    };

    const resetTimer = () => {
        if (elapsedSec > 0 || timeoutTeam) {
            if (!confirm("Reset the match timer back to 0? Any active timeout will also be cleared.")) return;
        }
        alarmFiredRef.current = false;
        toAlarmFiredRef.current = false;
        setActive({
            timerRunning: false,
            timerStartAt: null,
            timerAccumMs: 0,
            timeoutTeam: null,
            timeoutStartAt: null,
        });
    };

    const stopTimeout = () => {
        if (!timeoutTeam) return;
        toAlarmFiredRef.current = false;
        setActive({
            timeoutTeam: null,
            timeoutStartAt: null,
        });
    };

    const callTimeout = (which) => {
        if (timeoutTeam) return;
        const used = which === "A" ? timeoutsUsedA : timeoutsUsedB;
        if (used >= TIMEOUTS_PER_TEAM) return;
        setActive({
            timerRunning: false,
            timerStartAt: null,
            timerAccumMs: match.elapsedMs,
            timeoutTeam: which,
            timeoutStartAt: Date.now(),
            [which === "A" ? "timeoutsUsedA" : "timeoutsUsedB"]: used + 1,
        });
    };

    const endTimeout = () => {
        setActive({
            timeoutTeam: null,
            timeoutStartAt: null,
            timerRunning: true,
            timerStartAt: Date.now(),
        });
    };

    const timeoutIdx = timeoutTeam ? teams.findIndex(x => x.id === (timeoutTeam === "A" ? teamAId : teamBId)) : -1;
    const timeoutColor = timeoutIdx >= 0 ? teamColor(timeoutIdx) : null;

    const endMatch = () => {
        if (scoreA === 0 && scoreB === 0) {
            if (!confirm("Both scores are 0. Record this match anyway?")) return;
        } else if (!confirm("End this match? Score will be saved to the tournament.")) {
            return;
        }
        patchTournament(t => {
            const nextActive = { ...(t.activeMatches || {}) };
            delete nextActive[slotKey];
            return {
                ...t,
                matches: [...(t.matches || []), {
                    id: uid(),
                    teamAId, teamBId,
                    scoreA, scoreB,
                    durationSec: elapsedSec,
                    endedAt: new Date().toISOString(),
                }],
                activeMatches: nextActive,
            };
        });
        alarmFiredRef.current = false;
        toAlarmFiredRef.current = false;
        showToast?.("Match recorded");
    };

    const renderTournamentTile = (which, teamId, score) => {
        const idx = teams.findIndex(t => t.id === teamId);
        const name = teams[idx]?.name || "Team";
        const used = which === "A" ? timeoutsUsedA : timeoutsUsedB;
        const remainingTO = Math.max(0, TIMEOUTS_PER_TEAM - used);
        return (
            <div className="scoreboard-team" style={{ "--team-color": teamColor(idx) }}>
                <select
                    className="scoreboard-team-picker"
                    value={teamId}
                    onChange={e => pickTeam(which, e.target.value)}
                    disabled={!!timeoutTeam}
                >
                    {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <div className="score-value">{score}</div>
                <div className="score-controls">
                    <button className="btn btn-secondary" onClick={() => bump(which, -1)} aria-label={`${name} minus one`}>−</button>
                    <button className="btn" onClick={() => bump(which, +1)} aria-label={`${name} plus one`}>+</button>
                </div>
                <div className="timeout-row">
                    <div className="timeout-dots" aria-label={`${remainingTO} of ${TIMEOUTS_PER_TEAM} timeouts remaining`}>
                        {Array.from({ length: TIMEOUTS_PER_TEAM }).map((_, i) => (
                            <span key={i} className={`timeout-dot${i < used ? " used" : ""}`}></span>
                        ))}
                    </div>
                    <button
                        className="btn btn-secondary timeout-btn"
                        onClick={() => callTimeout(which)}
                        disabled={remainingTO === 0 || !!timeoutTeam || expired}
                        title={remainingTO === 0 ? "No timeouts left" : `Call timeout (${remainingTO} left)`}
                    >
                        ⏱ Timeout
                    </button>
                </div>
            </div>
        );
    };

    return (
        <div className="card">
            <h2>Record Match</h2>
            {timeoutTeam && (
                <div
                    className="timeout-banner"
                    style={{
                        borderColor: timeoutColor,
                        background: timeoutColor ? `${timeoutColor}1a` : undefined,
                    }}
                >
                    <div className="timeout-banner-head">
                        <span className="timeout-banner-label" style={{ color: timeoutColor }}>
                            ⏱ Timeout · {teams.find(t => t.id === (timeoutTeam === "A" ? teamAId : teamBId))?.name || "Team"}
                        </span>
                        <span className="timeout-banner-time" style={{ color: timeoutColor }}>
                            {toMM}:{toSS.toString().padStart(2, "0")}
                        </span>
                    </div>
                    <div className="timeout-banner-actions">
                        <button className="btn" onClick={endTimeout}>End timeout</button>
                        <button
                            className="btn btn-secondary emergency-btn"
                            onClick={stopTimeout}
                            title="Emergency: end timeout WITHOUT restarting the match timer (use only if the match can't resume — injury, equipment issue, etc.)"
                        >⚠ Emergency: end without resuming</button>
                    </div>
                </div>
            )}
            {!timeoutTeam && (timerNotStarted || timerPaused) && (
                <div className="timer-reminder">
                    <span className="timer-reminder-icon">⏱</span>
                    <span className="timer-reminder-text">
                        {timerNotStarted
                            ? "Don't forget to start the timer when the match begins."
                            : "Timer is paused — resume it to keep tracking the match."}
                    </span>
                </div>
            )}
            <div className={`scoreboard-timer${expired ? " expired" : ""}`}>
                <div className="timer-display">
                    {mm}:{ss.toString().padStart(2, "0")}
                </div>
                <div className="timer-controls">
                    <button
                        className="btn"
                        onClick={toggleTimer}
                        disabled={(expired && !running) || !!timeoutTeam}
                    >
                        {running ? "Pause" : (elapsedSec > 0 ? "Resume" : "Start")}
                    </button>
                    <button className="btn btn-secondary" onClick={resetTimer}>Reset</button>
                    <span className="duration-static">{matchDurationMin} min match</span>
                </div>
            </div>
            <div className="scoreboard-teams scoreboard-2team">
                {renderTournamentTile("A", teamAId, scoreA)}
                <div className="vs-label">VS</div>
                {renderTournamentTile("B", teamBId, scoreB)}
            </div>
            <div className="btn-row">
                <button className="btn btn-danger" onClick={resetScores}>Reset Scores</button>
                <button className="btn" onClick={endMatch}>End Match</button>
            </div>
        </div>
    );
}

function PublicTeamsCard({ tournament }) {
    const teams = tournament.teams || [];
    if (teams.length === 0) {
        return (
            <div className="card">
                <h2>Teams</h2>
                <div className="empty">No teams yet.</div>
            </div>
        );
    }
    return (
        <div className="card">
            <h2>Teams</h2>
            <div className="tournament-teams">
                {teams.map((team, idx) => {
                    const color = teamColor(idx);
                    return (
                        <div key={team.id} className="t-team" style={{ borderLeftColor: color }}>
                            <div className="t-team-header">
                                <span className="t-team-name" style={{ color, cursor: "default" }}>
                                    {team.name}
                                    <span className="t-team-count"> · {team.players.length}</span>
                                </span>
                            </div>
                            {team.players.length === 0 ? (
                                <div className="help-text" style={{ marginTop: 0 }}>No players listed.</div>
                            ) : (
                                <div className="t-team-chips">
                                    {team.players.map(p => (
                                        <span key={p} className="t-chip">{p}</span>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// Round-robin pairings for the tournament's teams, used to seed a schedule.
const generateRoundRobin = (teams) => {
    const out = [];
    for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
            out.push({ id: uid(), teamAId: teams[i].id, teamBId: teams[j].id });
        }
    }
    return out;
};

// Shuffle a copy of the schedule array (Fisher-Yates), preserving items.
const shuffleArr = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};

function ScheduleCard({ tournament, patchTournament, canManage, showToast }) {
    const teams = tournament.teams || [];
    const matches = tournament.matches || [];
    const schedule = tournament.schedule || [];
    const finalized = tournament.scheduleFinalized !== false;

    if (teams.length < 2) {
        if (!canManage) return null;
        return (
            <div className="card">
                <h2>Schedule</h2>
                <div className="empty">Add at least two teams before scheduling matches.</div>
            </div>
        );
    }

    // Non-admin viewers see nothing until the admin publishes.
    if (!canManage && !finalized) {
        return (
            <div className="card">
                <h2>Schedule</h2>
                <div className="empty">Admin is working on the schedule. It'll appear here once published.</div>
            </div>
        );
    }

    const pairKey = (idA, idB) => [idA, idB].sort().join("|");
    const byPair = {};
    matches.forEach(m => {
        const k = pairKey(m.teamAId, m.teamBId);
        (byPair[k] = byPair[k] || []).push(m);
    });

    const teamsById = Object.fromEntries(teams.map((t, i) => [t.id, { ...t, idx: i }]));
    const playedCount = schedule.filter(s => (byPair[pairKey(s.teamAId, s.teamBId)] || []).length > 0).length;

    const generate = () => {
        if (!canManage) return;
        const next = generateRoundRobin(teams);
        patchTournament(t => ({ ...t, schedule: next, scheduleFinalized: false }));
        showToast?.(`${next.length} match${next.length === 1 ? "" : "es"} scheduled`);
    };

    const reshuffle = () => {
        if (!canManage) return;
        if (schedule.length === 0) return;
        patchTournament(t => ({
            ...t,
            schedule: shuffleArr(t.schedule || []),
            scheduleFinalized: false,
        }));
        showToast?.("Schedule reshuffled — remember to finalize");
    };

    const clearAll = () => {
        if (!canManage) return;
        if (!confirm("Remove every scheduled match? Match results are kept.")) return;
        patchTournament(t => ({ ...t, schedule: [], scheduleFinalized: true }));
    };

    const moveRow = (idx, delta) => {
        if (!canManage) return;
        patchTournament(t => {
            const list = [...(t.schedule || [])];
            const target = idx + delta;
            if (target < 0 || target >= list.length) return t;
            [list[idx], list[target]] = [list[target], list[idx]];
            return { ...t, schedule: list, scheduleFinalized: false };
        });
    };

    const removeRow = (id) => {
        if (!canManage) return;
        patchTournament(t => ({
            ...t,
            schedule: (t.schedule || []).filter(s => s.id !== id),
            scheduleFinalized: false,
        }));
    };

    const toggleFinalize = () => {
        if (!canManage) return;
        patchTournament(t => ({ ...t, scheduleFinalized: !(t.scheduleFinalized !== false) }));
        showToast?.(finalized ? "Schedule unpublished — only you can see edits now" : "Schedule published");
    };

    return (
        <div className="card">
            <div className="card-header-row">
                <h2 style={{ margin: 0 }}>
                    Schedule ({playedCount}/{schedule.length || 0})
                    {canManage && !finalized && schedule.length > 0 && (
                        <span className="draft-badge" title="Only you can see this draft until you publish">Draft</span>
                    )}
                </h2>
            </div>

            {schedule.length === 0 ? (
                <div className="empty">
                    {canManage
                        ? "No schedule yet. Generate a round-robin from the current teams, or add matches later."
                        : "No matches scheduled yet."}
                </div>
            ) : (
                <div className="schedule-list">
                    {schedule.map((s, idx) => {
                        const a = teamsById[s.teamAId];
                        const b = teamsById[s.teamBId];
                        if (!a || !b) return null;
                        const played = byPair[pairKey(s.teamAId, s.teamBId)] || [];
                        const colorA = teamColor(a.idx);
                        const colorB = teamColor(b.idx);
                        return (
                            <div className={`schedule-row ${played.length > 0 ? "done" : "pending"}`} key={s.id}>
                                <div className="schedule-row-main">
                                    <span className="schedule-pos">{idx + 1}</span>
                                    <div className="schedule-pairing">
                                        <span className="schedule-team" style={{ color: colorA }}>{a.name}</span>
                                        <span className="schedule-vs">vs</span>
                                        <span className="schedule-team" style={{ color: colorB }}>{b.name}</span>
                                    </div>
                                </div>
                                <div className="schedule-row-side">
                                    <span className="schedule-result">
                                        {played.length === 0 ? (
                                            <span className="fixture-pending">Pending</span>
                                        ) : (
                                            played.map((m, i) => {
                                                const sA = m.teamAId === a.id ? m.scoreA : m.scoreB;
                                                const sB = m.teamAId === a.id ? m.scoreB : m.scoreA;
                                                const aWon = sA > sB;
                                                const bWon = sB > sA;
                                                return (
                                                    <span key={m.id} className="fixture-score">
                                                        {i > 0 && <span className="fixture-sep">·</span>}
                                                        <span className={aWon ? "winner-side" : ""}>{sA}</span>
                                                        <span className="fixture-dash">–</span>
                                                        <span className={bWon ? "winner-side" : ""}>{sB}</span>
                                                    </span>
                                                );
                                            })
                                        )}
                                    </span>
                                    {canManage && (
                                        <div className="schedule-row-controls">
                                            <button className="icon-btn" onClick={() => moveRow(idx, -1)} disabled={idx === 0} title="Move up">▲</button>
                                            <button className="icon-btn" onClick={() => moveRow(idx, +1)} disabled={idx === schedule.length - 1} title="Move down">▼</button>
                                            <button className="icon-btn" onClick={() => removeRow(s.id)} title="Remove">✕</button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {canManage && (
                <>
                    <div className="btn-row" style={{ marginTop: "0.75rem" }}>
                        <button className="btn" onClick={generate}>
                            {schedule.length > 0 ? "Regenerate round-robin" : "Generate round-robin"}
                        </button>
                        {schedule.length > 0 && (
                            <button className="btn btn-secondary" onClick={reshuffle}>Reshuffle order</button>
                        )}
                        {schedule.length > 0 && (
                            <button className="btn btn-secondary danger" onClick={clearAll}>Clear</button>
                        )}
                    </div>
                    {schedule.length > 0 && (
                        <div className="btn-row">
                            {!finalized ? (
                                <button className="btn" onClick={toggleFinalize}>Finalize schedule · Publish</button>
                            ) : (
                                <button className="btn btn-secondary" onClick={toggleFinalize}>Edit schedule (unpublish)</button>
                            )}
                        </div>
                    )}
                    {!finalized && schedule.length > 0 && (
                        <p className="help-text">Only you can see this schedule. Tap <strong>Finalize schedule · Publish</strong> to make it visible to everyone.</p>
                    )}
                </>
            )}
        </div>
    );
}

function TournamentHistoryCard({ tournaments, onOpen }) {
    const ended = tournaments
        .filter(t => t.endedAt)
        .sort((a, b) => (b.endedAt || "").localeCompare(a.endedAt || ""));
    if (ended.length === 0) return null;
    return (
        <div className="card">
            <h2>Past Tournaments ({ended.length})</h2>
            <div className="history-list">
                {ended.map(t => {
                    const standings = computeStandings(t.teams || [], t.matches || []);
                    const winner = standings[0]?.played > 0 ? standings[0].team : null;
                    return (
                        <div className="history-row" key={t.id} onClick={() => onOpen?.(t.id)}>
                            <div className="history-name">{t.name}</div>
                            <div className="history-meta">
                                {formatDate(t.date)}
                                {" · "}{(t.teams || []).length} teams
                                {" · "}{(t.matches || []).length} matches
                            </div>
                            <div className="history-winner">
                                {winner ? <>🏆 <strong>{winner.name}</strong></> : <span className="muted">No winner</span>}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function TournamentMatchCard({ match, teams, index, canDelete, onDelete }) {
    const aIdx = teams.findIndex(t => t.id === match.teamAId);
    const bIdx = teams.findIndex(t => t.id === match.teamBId);
    const a = aIdx >= 0 ? teams[aIdx] : null;
    const b = bIdx >= 0 ? teams[bIdx] : null;
    const colorA = aIdx >= 0 ? teamColor(aIdx) : "var(--border-strong)";
    const colorB = bIdx >= 0 ? teamColor(bIdx) : "var(--border-strong)";
    const aWin = match.scoreA > match.scoreB;
    const bWin = match.scoreB > match.scoreA;
    const mins = Math.floor((match.durationSec || 0) / 60);
    const secs = (match.durationSec || 0) % 60;
    const styleFor = (color, win) => win
        ? { background: color, borderColor: color, borderLeftColor: color }
        : { borderLeftColor: color };
    return (
        <div className="match-card tournament-match">
            <div className="match-card-header">
                <span className="match-card-num">Match {index + 1}</span>
                <span className="match-card-time">
                    {mins}:{secs.toString().padStart(2, "0")}
                </span>
                {canDelete && (
                    <button className="icon-btn match-del" onClick={() => onDelete?.(match.id)} title="Delete match">✕</button>
                )}
            </div>
            <div className="match-card-body">
                <div className={`match-side${aWin ? " winner" : ""}`} style={styleFor(colorA, aWin)}>
                    <span className="match-side-label">{a?.name || "—"}</span>
                    <span className="match-side-score">{match.scoreA}</span>
                </div>
                <div className={`match-side${bWin ? " winner" : ""}`} style={styleFor(colorB, bWin)}>
                    <span className="match-side-label">{b?.name || "—"}</span>
                    <span className="match-side-score">{match.scoreB}</span>
                </div>
            </div>
        </div>
    );
}

function KindChooserCard({ onCreate, onCancel, existingNames }) {
    const [name, setName] = useState("");
    const [date, setDate] = useState(todayISO());
    const [matchMin, setMatchMin] = useState(DEFAULT_MATCH_MIN);
    const [timeoutMin, setTimeoutMin] = useState(DEFAULT_TIMEOUT_MIN);
    const [kind, setKind] = useState(null);
    const [error, setError] = useState("");

    const trimmedName = name.trim();
    const nameTaken = !!trimmedName && (existingNames || []).some(n => n.toLowerCase() === trimmedName.toLowerCase());
    const canCreate = !!trimmedName && !!kind && !nameTaken;

    const handleCreate = () => {
        if (!canCreate) {
            if (!trimmedName) setError("Please enter a tournament name.");
            else if (!kind) setError("Pick a tournament kind.");
            else if (nameTaken) setError("A tournament with that name already exists.");
            return;
        }
        onCreate({ kind, name: trimmedName, date, matchMin, timeoutMin });
    };

    return (
        <div className="card kind-chooser">
            <h2>Create a new tournament</h2>

            <div className="duration-grid">
                <label className="duration-field duration-field-wide">
                    <span>Name</span>
                    <input
                        type="text"
                        value={name}
                        placeholder="e.g. Weekly Game"
                        onChange={e => { setName(e.target.value); if (error) setError(""); }}
                        onKeyDown={e => { if (e.key === "Enter") handleCreate(); }}
                        autoFocus
                    />
                </label>
                <label className="duration-field">
                    <span>Date</span>
                    <input
                        type="date"
                        value={date}
                        onChange={e => setDate(e.target.value || todayISO())}
                    />
                </label>
                <div className="duration-row-break"></div>
                <label className="duration-field">
                    <span>Match length</span>
                    <input
                        type="number" min="1" max="99"
                        value={matchMin}
                        onChange={e => setMatchMin(Math.max(1, Number(e.target.value) || DEFAULT_MATCH_MIN))}
                    />
                    <span className="duration-unit">min</span>
                </label>
                <label className="duration-field">
                    <span>Timeout length</span>
                    <input
                        type="number" min="1" max="10"
                        value={timeoutMin}
                        onChange={e => setTimeoutMin(Math.max(1, Number(e.target.value) || DEFAULT_TIMEOUT_MIN))}
                    />
                    <span className="duration-unit">min</span>
                </label>
                <p className="help-text duration-help">
                    {TIMEOUTS_PER_TEAM} timeouts per team per match. All fields lock once the tournament is created.
                </p>
            </div>

            <h3 className="kind-chooser-subheading">Pick a kind</h3>
            <div className="kind-grid">
                <button
                    type="button"
                    className={`kind-option ${kind === TOURNAMENT_KIND_ROSTER ? "selected" : ""}`}
                    onClick={() => { setKind(TOURNAMENT_KIND_ROSTER); if (error) setError(""); }}
                    aria-pressed={kind === TOURNAMENT_KIND_ROSTER}
                >
                    <span className="kind-option-icon" aria-hidden="true">🎲</span>
                    <span className="kind-option-title">Roster · AI teams</span>
                    <span className="kind-option-desc">
                        Build a roster of players (categories &amp; ranks). AI generates balanced
                        teams from everyone marked available. Best for weekly games.
                    </span>
                </button>
                <button
                    type="button"
                    className={`kind-option ${kind === TOURNAMENT_KIND_TEAMS ? "selected" : ""}`}
                    onClick={() => { setKind(TOURNAMENT_KIND_TEAMS); if (error) setError(""); }}
                    aria-pressed={kind === TOURNAMENT_KIND_TEAMS}
                >
                    <span className="kind-option-icon" aria-hidden="true">🏆</span>
                    <span className="kind-option-title">Preset teams</span>
                    <span className="kind-option-desc">
                        Add teams directly (e.g. one per state) and record matches between them.
                        Best for a big tournament with fixed rosters.
                    </span>
                </button>
            </div>

            {error && <p className="help-text kind-chooser-error">{error}</p>}

            <div className="btn-row">
                <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
                <button className="btn" onClick={handleCreate} disabled={!canCreate}>Create tournament</button>
            </div>
        </div>
    );
}

function TournamentView({ tournaments, setTournaments, rosterTemplates, setRosterTemplates, showToast, canManage, canScore, tournamentTab, setTournamentTab, selectedTournamentId, setSelectedTournamentId, scorerKey }) {
    const selectedId = selectedTournamentId && tournaments.some(t => t.id === selectedTournamentId)
        ? selectedTournamentId
        : (tournaments[tournaments.length - 1]?.id || null);
    const setSelectedId = (id) => setSelectedTournamentId(id);

    const activeTournament = tournaments.find(t => t.id === selectedId)
        || tournaments[tournaments.length - 1]
        || null;

    const patchTournament = (updater) => {
        if (!activeTournament) return;
        setTournaments(prev => prev.map(t => t.id === activeTournament.id ? updater(t) : t));
    };

    const [picking, setPicking] = useState(false);

    const createTournament = ({ kind, name, date, matchMin, timeoutMin }) => {
        const label = kind === TOURNAMENT_KIND_ROSTER ? "Roster tournament" : "Team tournament";
        const t = makeTournament(name, kind, date, matchMin, timeoutMin);
        setTournaments(prev => [...prev, t]);
        setSelectedId(t.id);
        setTournamentTab(kind === TOURNAMENT_KIND_ROSTER ? "roster" : "teams");
        setPicking(false);
        showToast?.(`${label} "${name}" created`);
    };

    const startCreate = () => setPicking(true);

    const renameTournament = () => {
        if (!activeTournament) return;
        const name = (prompt("Rename tournament:", activeTournament.name) || "").trim();
        if (!name || name === activeTournament.name) return;
        if (tournaments.some(t => t.id !== activeTournament.id && t.name.toLowerCase() === name.toLowerCase())) {
            alert("A tournament with that name already exists.");
            return;
        }
        patchTournament(t => ({ ...t, name }));
    };

    const deleteTournament = () => {
        if (!activeTournament) return;
        if (!confirm(`Delete tournament "${activeTournament.name}"? This can't be undone.`)) return;
        setTournaments(prev => prev.filter(t => t.id !== activeTournament.id));
        showToast?.("Tournament deleted");
    };

    const setDate = (newDate) => {
        if (!newDate) return;
        patchTournament(t => ({ ...t, date: newDate }));
    };

    const endTournament = () => {
        if (!activeTournament) return;
        if (!confirm(`End "${activeTournament.name}"? No more matches can be recorded until it's reopened.`)) return;
        patchTournament(t => ({ ...t, endedAt: new Date().toISOString() }));
        showToast?.("Tournament ended");
    };

    const reopenTournament = () => {
        if (!activeTournament) return;
        if (!confirm("Reopen this tournament? Matches can be recorded again.")) return;
        patchTournament(t => ({ ...t, endedAt: null }));
        showToast?.("Tournament reopened");
    };

    const deleteMatch = (id) => {
        if (!confirm("Delete this match?")) return;
        patchTournament(t => ({ ...t, matches: (t.matches || []).filter(m => m.id !== id) }));
    };

    if (!activeTournament) {
        return (
            <>
                <div className="card">
                    <h2>Tournaments</h2>
                    <div className="empty">No tournaments yet.</div>
                    {canManage && !picking && (
                        <div className="btn-row">
                            <button className="btn" onClick={startCreate}>+ Create Tournament</button>
                        </div>
                    )}
                </div>
                {canManage && picking && (
                    <KindChooserCard
                        onCreate={createTournament}
                        onCancel={() => setPicking(false)}
                        existingNames={tournaments.map(t => t.name)}
                    />
                )}
            </>
        );
    }

    const teams = activeTournament.teams || [];
    const matches = [...(activeTournament.matches || [])].reverse();
    const played = (activeTournament.matches || []).length;
    const standings = computeStandings(teams, activeTournament.matches || []);
    const possibleMatches = teams.length >= 2 ? (teams.length * (teams.length - 1)) / 2 : 0;
    const remainingMatches = Math.max(0, possibleMatches - played);
    const ended = !!activeTournament.endedAt;
    const champion = ended && standings[0] && standings[0].played > 0 ? standings[0].team : null;

    const championIdx = champion ? teams.findIndex(t => t.id === champion.id) : -1;
    const championColor = championIdx >= 0 ? teamColor(championIdx) : null;

    const otherTournaments = tournaments.filter(t => t.id !== activeTournament.id);
    const canRecord = !ended && (canManage || canScore);
    const isRoster = activeTournament.kind === TOURNAMENT_KIND_ROSTER;
    const tabs = [
        { key: "standings", label: "Standings" },
        ...(isRoster
            ? [{ key: "roster", label: "Roster" }, { key: "teams", label: "Teams" }]
            : [{ key: "teams", label: "Teams" }]),
        { key: "schedule", label: "Schedule" },
        ...(canRecord ? [{ key: "score", label: "Score" }] : []),
        { key: "matches", label: `Matches (${played})` },
        { key: "rules", label: "Rules" },
        ...(otherTournaments.length > 0 ? [{ key: "past", label: "Past" }] : []),
    ];
    const validKeys = tabs.map(t => t.key);
    const currentTab = validKeys.includes(tournamentTab) ? tournamentTab : "standings";

    return (
        <div className={`tournament-view${currentTab === "score" ? " score-mode" : ""}`}>
            {canManage && picking && (
                <KindChooserCard
                    onCreate={createTournament}
                    onCancel={() => setPicking(false)}
                    existingNames={tournaments.map(t => t.name)}
                />
            )}
            {canManage && (
                <div className="roster-bar tournament-admin-bar">
                    {tournaments.length > 1 ? (
                        <select
                            value={activeTournament.id}
                            onChange={e => setSelectedId(e.target.value)}
                        >
                            {tournaments.map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                        </select>
                    ) : (
                        <span className="roster-name-static">{activeTournament.name}</span>
                    )}
                    <button className="btn btn-secondary" onClick={startCreate}>+ New</button>
                    <button className="btn btn-secondary" onClick={renameTournament}>Rename</button>
                    {ended ? (
                        <button className="btn btn-secondary" onClick={reopenTournament}>Reopen</button>
                    ) : (
                        <button className="btn btn-secondary" onClick={endTournament}>End Tournament</button>
                    )}
                    <button className="btn btn-secondary danger" onClick={deleteTournament}>Delete</button>
                </div>
            )}

            {!canManage && tournaments.length > 1 && (
                <div className="roster-bar">
                    <span className="roster-label">Tournament</span>
                    <select
                        value={activeTournament.id}
                        onChange={e => setSelectedId(e.target.value)}
                    >
                        {tournaments.map(t => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                    </select>
                </div>
            )}

            <div className="card tournament-top">
                <div className="tournament-hero">
                    <h1 className="tournament-title-big">{activeTournament.name}</h1>
                    <div className="tournament-hero-date">
                        {canManage ? (
                            <input
                                type="date"
                                value={activeTournament.date || todayISO()}
                                onChange={e => setDate(e.target.value)}
                                title="Change tournament date"
                            />
                        ) : (
                            <span className="tournament-date">{formatDate(activeTournament.date)}</span>
                        )}
                        <span className={`kind-badge kind-${isRoster ? "roster" : "teams"}`}>
                            {isRoster ? "Roster · AI teams" : "Preset teams"}
                        </span>
                        {ended && <span className="ended-badge">Ended</span>}
                    </div>
                </div>
                {champion && (
                    <div
                        className="champion-banner"
                        style={{
                            background: `${championColor}1a`,
                            borderColor: championColor,
                        }}
                    >
                        🏆 Winner: <strong style={{ color: championColor }}>{champion.name}</strong>
                    </div>
                )}
            </div>

            <nav className="tournament-tabs">
                {tabs.map(t => (
                    <button
                        key={t.key}
                        className={currentTab === t.key ? "active" : ""}
                        onClick={() => setTournamentTab(t.key)}
                    >{t.label}</button>
                ))}
            </nav>

            {currentTab === "standings" && (
                <div className="card">
                    <h2>Standings</h2>
                    <StandingsTable standings={standings} teams={teams} />
                </div>
            )}

            {currentTab === "teams" && !isRoster && (
                canManage ? (
                    <TeamsManagerCard
                        tournament={activeTournament}
                        patchTournament={patchTournament}
                        disabled={ended}
                        showToast={showToast}
                    />
                ) : (
                    <PublicTeamsCard tournament={activeTournament} />
                )
            )}

            {currentTab === "roster" && isRoster && (
                <RosterTournamentCard
                    tournament={activeTournament}
                    patchTournament={patchTournament}
                    disabled={ended || !canManage}
                    showToast={showToast}
                    rosterTemplates={rosterTemplates}
                    setRosterTemplates={canManage ? setRosterTemplates : null}
                />
            )}

            {currentTab === "teams" && isRoster && (
                <RosterTeamsCard
                    tournament={activeTournament}
                    patchTournament={patchTournament}
                    disabled={ended || !canManage}
                />
            )}

            {currentTab === "schedule" && (
                <ScheduleCard
                    tournament={activeTournament}
                    patchTournament={patchTournament}
                    canManage={canManage}
                    showToast={showToast}
                />
            )}

            {currentTab === "score" && canRecord && (
                <TournamentScoreboard
                    tournament={activeTournament}
                    patchTournament={patchTournament}
                    showToast={showToast}
                    scorerKey={scorerKey}
                />
            )}

            {currentTab === "matches" && (
                <div className="card">
                    <h2>Matches Played ({(activeTournament.matches || []).length})</h2>
                    {matches.length === 0 ? (
                        <div className="empty">No matches recorded yet.</div>
                    ) : (
                        <div className="match-list">
                            {matches.map((m, i) => (
                                <TournamentMatchCard
                                    key={m.id || i}
                                    match={m}
                                    teams={teams}
                                    index={(activeTournament.matches || []).length - 1 - i}
                                    canDelete={canManage || canScore}
                                    onDelete={deleteMatch}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}

            {currentTab === "rules" && (
                <div className="card">
                    <h2>Rules</h2>
                    <div className="tournament-stats">
                        <div className="stat"><div className="num">{teams.length}</div><div className="label">Teams</div></div>
                        <div className="stat"><div className="num">{played}</div><div className="label">Played</div></div>
                        <div className="stat"><div className="num">{remainingMatches}</div><div className="label">Remaining</div></div>
                    </div>
                    <ul className="rules-list">
                        <li><span>Match length</span><strong>{activeTournament.matchDurationMin || DEFAULT_MATCH_MIN} min</strong></li>
                        <li><span>Timeout length</span><strong>{activeTournament.timeoutDurationMin || DEFAULT_TIMEOUT_MIN} min</strong></li>
                        <li><span>Timeouts per team per match</span><strong>{TIMEOUTS_PER_TEAM}</strong></li>
                    </ul>
                </div>
            )}

            {currentTab === "past" && (
                <TournamentHistoryCard
                    tournaments={otherTournaments}
                    onOpen={(id) => { setSelectedId(id); setTournamentTab("standings"); }}
                />
            )}
        </div>
    );
}

function LiveView({ tournaments, setTournaments, onViewTournament, showToast }) {
    const tournamentList = tournaments || [];
    const canManage = typeof setTournaments === "function";

    // A match is "live" once the scorer has done something — bumped a score,
    // started the timer, or called a timeout. Pre-match defaults (teams picked
    // but nothing played yet) stay off the Live tab.
    const isMatchLive = (m) => {
        if (!m) return false;
        if ((m.scoreA || 0) > 0 || (m.scoreB || 0) > 0) return true;
        if ((m.timeoutsUsedA || 0) > 0 || (m.timeoutsUsedB || 0) > 0) return true;
        if (m.timerRunning) return true;
        if ((Number(m.timerAccumMs) || 0) > 0) return true;
        if (m.timeoutTeam) return true;
        return false;
    };

    // Clears a stuck active-match slot without recording a match. Used when the
    // scorer forgot to tap "End Match" and the row stays live forever.
    const dismissSlot = (tournamentId, slotKey) => {
        if (!canManage) return;
        if (!confirm("Clear this live match? Any un-ended score will be discarded (nothing is recorded).")) return;
        setTournaments(prev => prev.map(t => {
            if (t.id !== tournamentId) return t;
            const nextActive = { ...(t.activeMatches || {}) };
            delete nextActive[slotKey];
            return { ...t, activeMatches: nextActive };
        }));
        showToast?.("Live match cleared");
    };

    // Patch a single active-match slot (used for Pause/Resume from the Live
    // view). Admin/scorer only.
    const patchSlot = (tournamentId, slotKey, patch) => {
        if (!canManage) return;
        setTournaments(prev => prev.map(t => {
            if (t.id !== tournamentId) return t;
            const existing = (t.activeMatches && t.activeMatches[slotKey]) || {};
            return {
                ...t,
                activeMatches: {
                    ...(t.activeMatches || {}),
                    [slotKey]: { ...existing, ...patch },
                },
            };
        }));
    };

    // Group live matches by tournament so each tournament renders ONE card
    // (even if several of its courts are live), with the recent-matches list
    // and View Tournament button appearing once per tournament.
    const liveTournaments = [];
    tournamentList.forEach(t => {
        if (t.endedAt) return;
        // Roster-kind tournaments whose teams aren't published yet shouldn't
        // show live matches to anyone (viewers would see draft team names).
        if (t.kind === TOURNAMENT_KIND_ROSTER && t.teamsFinalized === false) return;
        const activeMatches = t.activeMatches || {};
        const slots = [];
        Object.entries(activeMatches).forEach(([key, m]) => {
            if (!m || !m.teamAId || !m.teamBId) return;
            if (!(t.teams || []).some(x => x.id === m.teamAId)) return;
            if (!(t.teams || []).some(x => x.id === m.teamBId)) return;
            if (!isMatchLive(m)) return;
            slots.push({ match: m, slotKey: key });
        });
        if (slots.length > 0) liveTournaments.push({ tournament: t, slots });
    });

    if (liveTournaments.length === 0) {
        return (
            <div className="card">
                <div className="empty">
                    No live match right now. Check back when a game is in progress.
                </div>
            </div>
        );
    }

    return (
        <div>
            {liveTournaments.map(({ tournament, slots }) => (
                <TournamentLiveCard
                    key={tournament.id}
                    tournament={tournament}
                    slots={slots}
                    onViewTournament={onViewTournament}
                    onDismissSlot={canManage ? (slotKey) => dismissSlot(tournament.id, slotKey) : null}
                    onPatchSlot={canManage ? (slotKey, patch) => patchSlot(tournament.id, slotKey, patch) : null}
                />
            ))}
        </div>
    );
}

function LiveTimerDisplay({ state, matchDurationMin, timeoutDurationMin, timeoutColor }) {
    const running = !!state?.timerRunning;
    const timeoutTeam = state?.timeoutTeam || null;
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!running && !timeoutTeam) return;
        setNow(Date.now());
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [running, timeoutTeam]);
    const match = computeMatchTime(state, matchDurationMin, now);
    const toT = computeTimeoutTime(state, timeoutDurationMin, now);
    const mm = Math.floor(match.remainingSec / 60);
    const ss = match.remainingSec % 60;
    const toMM = Math.floor(toT.remainingSec / 60);
    const toSS = toT.remainingSec % 60;

    // Match timer is always shown. If a timeout is in progress the match
    // timer is paused and the timeout timer appears alongside it.
    const matchLabel = running ? "Live" : (match.elapsedSec > 0 ? "Paused" : "Pre-match");
    const matchClass = match.expired ? "expired" : (running ? "running" : (match.elapsedSec > 0 ? "paused" : "pre"));
    const showTimeout = !!timeoutTeam;
    const timeoutStyle = timeoutColor ? {
        borderColor: timeoutColor,
        background: `${timeoutColor}1a`,
    } : undefined;
    const timeoutTextStyle = timeoutColor ? { color: timeoutColor } : undefined;

    return (
        <div className={`live-timer-row${match.expired ? " expired" : ""}${showTimeout ? " with-timeout" : ""}`}>
            <div className={`live-timer live-timer-main ${matchClass}`}>
                <span className="live-timer-label">{matchLabel}</span>
                <span className="live-timer-value">
                    {mm}:{ss.toString().padStart(2, "0")}
                </span>
            </div>
            {showTimeout && (
                <div className="live-timer live-timer-timeout" style={timeoutStyle}>
                    <span className="live-timer-label" style={timeoutTextStyle}>Timeout</span>
                    <span className="live-timer-value" style={timeoutTextStyle}>
                        {toMM}:{toSS.toString().padStart(2, "0")}
                    </span>
                </div>
            )}
        </div>
    );
}

function TimeoutsBadge({ color, used, label }) {
    return (
        <div className="live-timeouts">
            <span className="live-timeouts-label">{label}</span>
            <div className="timeout-dots" style={{ "--team-color": color }}>
                {Array.from({ length: TIMEOUTS_PER_TEAM }).map((_, i) => (
                    <span key={i} className={`timeout-dot${i < (used || 0) ? " used" : ""}`}></span>
                ))}
            </div>
        </div>
    );
}

function WeeklyLiveCard({ session, members, roster }) {
    const teams = session.teams;
    const sb = session.scoreboard || {};
    let teamIdxA = Number.isInteger(sb.teamIdxA) ? sb.teamIdxA : 0;
    let teamIdxB = Number.isInteger(sb.teamIdxB) ? sb.teamIdxB : 1;
    if (teamIdxA >= teams.length) teamIdxA = 0;
    if (teamIdxB >= teams.length) teamIdxB = Math.min(1, teams.length - 1);
    if (teamIdxA === teamIdxB) teamIdxB = (teamIdxA + 1) % teams.length;
    const scoreA = sb.scoreA || 0;
    const scoreB = sb.scoreB || 0;
    const timeoutsUsedA = sb.timeoutsUsedA || 0;
    const timeoutsUsedB = sb.timeoutsUsedB || 0;
    const labelA = String.fromCharCode(65 + teamIdxA);
    const labelB = String.fromCharCode(65 + teamIdxB);
    const teamA = (teams[teamIdxA] || []).map(id => members.find(m => m.id === id)).filter(Boolean);
    const teamB = (teams[teamIdxB] || []).map(id => members.find(m => m.id === id)).filter(Boolean);
    const aWin = scoreA > scoreB;
    const bWin = scoreB > scoreA;
    const WEEKLY_HEX = ["#FF4D6D", "#00F0FF", "#FFC107"];
    const colorA = WEEKLY_HEX[teamIdxA % 3];
    const colorB = WEEKLY_HEX[teamIdxB % 3];

    return (
        <div className="card">
            <div className="live-head">
                <span className="live-badge"><span className="live-dot"></span>LIVE</span>
                <div className="live-title">
                    <h2>{roster?.name || "Session"}</h2>
                    <span className="live-sub">{formatDate(session.date)}</span>
                </div>
            </div>
            <LiveTimerDisplay
                state={sb}
                matchDurationMin={session.matchDurationMin || DEFAULT_MATCH_MIN}
                timeoutDurationMin={session.timeoutDurationMin || DEFAULT_TIMEOUT_MIN}
                timeoutColor={sb.timeoutTeam === "A" ? colorA : sb.timeoutTeam === "B" ? colorB : null}
            />
            <div className="scoreboard-teams scoreboard-2team">
                <div className={`scoreboard-team team-${teamIdxA + 1}`}>
                    <div className="jersey">{labelA}</div>
                    <div className={`score-value${aWin ? " leading" : ""}`}>{scoreA}</div>
                    <TimeoutsBadge color={colorA} used={timeoutsUsedA} label="Timeouts" />
                </div>
                <div className="vs-label">VS</div>
                <div className={`scoreboard-team team-${teamIdxB + 1}`}>
                    <div className="jersey">{labelB}</div>
                    <div className={`score-value${bWin ? " leading" : ""}`}>{scoreB}</div>
                    <TimeoutsBadge color={colorB} used={timeoutsUsedB} label="Timeouts" />
                </div>
            </div>
            <div className="teams-grid live-teams">
                {[{ idx: teamIdxA, label: labelA, team: teamA }, { idx: teamIdxB, label: labelB, team: teamB }].map(({ idx, label, team }) => (
                    <div key={idx} className={`team team-${idx + 1}`}>
                        <div className="team-header">
                            <div className="jersey">{label}</div>
                            <div className="team-title">
                                <span className="name">Team {label}</span>
                                <span className="meta">{team.length} Players</span>
                            </div>
                        </div>
                        <div className="team-players">
                            {team.map(p => (
                                <div key={p.id} className="team-player" style={{ cursor: "default" }}>
                                    <span>{p.name}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
            {Array.isArray(session.matches) && session.matches.length > 0 && (
                <>
                    <h3 style={{ marginTop: "1.5rem" }}>Matches this session</h3>
                    <div className="match-list">
                        {session.matches.map((m, i) => (
                            <MatchCard key={m.id || i} match={m} index={i} />
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

function TournamentLiveMatch({ tournament, match: am }) {
    const teams = tournament.teams || [];
    const aIdx = teams.findIndex(t => t.id === am.teamAId);
    const bIdx = teams.findIndex(t => t.id === am.teamBId);
    const a = aIdx >= 0 ? teams[aIdx] : null;
    const b = bIdx >= 0 ? teams[bIdx] : null;
    if (!a || !b) return null;
    const scoreA = am.scoreA || 0;
    const scoreB = am.scoreB || 0;
    const timeoutsUsedA = am.timeoutsUsedA || 0;
    const timeoutsUsedB = am.timeoutsUsedB || 0;
    const colorA = teamColor(aIdx);
    const colorB = teamColor(bIdx);
    const aWin = scoreA > scoreB;
    const bWin = scoreB > scoreA;
    return (
        <div className="live-match-block">
            <LiveTimerDisplay
                state={am}
                matchDurationMin={tournament.matchDurationMin || DEFAULT_MATCH_MIN}
                timeoutDurationMin={tournament.timeoutDurationMin || DEFAULT_TIMEOUT_MIN}
                timeoutColor={am.timeoutTeam === "A" ? colorA : am.timeoutTeam === "B" ? colorB : null}
            />
            <div className="scoreboard-teams scoreboard-2team">
                <div className="scoreboard-team" style={{ "--team-color": colorA }}>
                    <div className="t-live-team-name" style={{ color: colorA }}>{a.name}</div>
                    <div className={`score-value${aWin ? " leading" : ""}`}>{scoreA}</div>
                    <TimeoutsBadge color={colorA} used={timeoutsUsedA} label="Timeouts" />
                </div>
                <div className="vs-label">VS</div>
                <div className="scoreboard-team" style={{ "--team-color": colorB }}>
                    <div className="t-live-team-name" style={{ color: colorB }}>{b.name}</div>
                    <div className={`score-value${bWin ? " leading" : ""}`}>{scoreB}</div>
                    <TimeoutsBadge color={colorB} used={timeoutsUsedB} label="Timeouts" />
                </div>
            </div>
        </div>
    );
}

// Compact single-row summary for one live match. Shown in the collapsed Live
// card so the Live tab is a quick glance across tournaments.
function LiveMatchSummary({ tournament, match: am }) {
    const teams = tournament.teams || [];
    const a = teams.find(t => t.id === am.teamAId);
    const b = teams.find(t => t.id === am.teamBId);
    if (!a || !b) return null;
    const aIdx = teams.findIndex(t => t.id === am.teamAId);
    const bIdx = teams.findIndex(t => t.id === am.teamBId);
    const colorA = teamColor(aIdx);
    const colorB = teamColor(bIdx);
    const scoreA = am.scoreA || 0;
    const scoreB = am.scoreB || 0;

    const matchDurationMin = tournament.matchDurationMin || DEFAULT_MATCH_MIN;
    const timeoutDurationMin = tournament.timeoutDurationMin || DEFAULT_TIMEOUT_MIN;
    const running = !!am.timerRunning;
    const timeoutTeam = am.timeoutTeam || null;
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!running && !timeoutTeam) return;
        setNow(Date.now());
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [running, timeoutTeam]);
    const match = computeMatchTime(am, matchDurationMin, now);
    const toT = computeTimeoutTime(am, timeoutDurationMin, now);
    const timeStr = timeoutTeam
        ? `${Math.floor(toT.remainingSec / 60)}:${(toT.remainingSec % 60).toString().padStart(2, "0")}`
        : `${Math.floor(match.remainingSec / 60)}:${(match.remainingSec % 60).toString().padStart(2, "0")}`;
    const statusLabel = timeoutTeam ? "Timeout" : (running ? "Live" : (match.elapsedSec > 0 ? "Paused" : "Pre-match"));

    return (
        <div className="live-brief">
            <div className="live-brief-score">
                <span className="live-brief-team" style={{ color: colorA }}>{a.name}</span>
                <span className="live-brief-num">{scoreA}</span>
                <span className="live-brief-dash">—</span>
                <span className="live-brief-num">{scoreB}</span>
                <span className="live-brief-team" style={{ color: colorB }}>{b.name}</span>
            </div>
            <div className="live-brief-time">
                <span className="live-brief-status">{statusLabel}</span>
                <span className="live-brief-clock">{timeStr}</span>
            </div>
        </div>
    );
}

function TournamentLiveCard({ tournament, slots, onViewTournament, onDismissSlot, onPatchSlot }) {
    const teams = tournament.teams || [];
    const allMatches = tournament.matches || [];
    const recentMatches = allMatches.slice(-3).reverse();
    const multi = slots.length > 1;
    const [expanded, setExpanded] = useState(false);
    const [activeIdx, setActiveIdx] = useState(0);
    const carouselRef = useRef(null);
    const matchDurationMin = tournament.matchDurationMin || DEFAULT_MATCH_MIN;

    // Keep activeIdx in range if the number of live slots shrinks (e.g. a match
    // ends while the card is open).
    useEffect(() => {
        if (activeIdx > slots.length - 1) {
            setActiveIdx(Math.max(0, slots.length - 1));
        }
    }, [slots.length, activeIdx]);

    // Pause/Resume toggle for a specific live slot. Captures the current
    // elapsedMs into timerAccumMs when pausing so the clock doesn't jump.
    const toggleSlotTimer = (slotKey, am) => {
        if (!onPatchSlot) return;
        if (am.timerRunning) {
            const now = Date.now();
            const prevAccum = Number(am.timerAccumMs) || 0;
            const liveMs = am.timerStartAt ? (now - am.timerStartAt) + prevAccum : prevAccum;
            onPatchSlot(slotKey, { timerRunning: false, timerStartAt: null, timerAccumMs: liveMs });
        } else {
            onPatchSlot(slotKey, { timerRunning: true, timerStartAt: Date.now() });
        }
    };

    const scrollToSlide = (idx) => {
        const el = carouselRef.current;
        if (!el) return;
        el.scrollTo({ left: idx * el.clientWidth, behavior: "smooth" });
        setActiveIdx(idx);
    };

    const onCarouselScroll = () => {
        const el = carouselRef.current;
        if (!el) return;
        const idx = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
        if (idx !== activeIdx) setActiveIdx(idx);
    };

    // Render one match's scoreboard + its scorer controls. Reused by both the
    // single-match layout and the multi-match swipe carousel so the controls
    // stay in sync.
    const renderSlot = ({ match: am, slotKey }) => {
        const running = !!am.timerRunning;
        const elapsed = (Number(am.timerAccumMs) || 0) > 0 || running;
        return (
            <>
                <TournamentLiveMatch tournament={tournament} match={am} />
                {(onPatchSlot || onDismissSlot) && (
                    <div className="btn-row live-controls">
                        {onPatchSlot && (
                            <button
                                className="btn"
                                onClick={() => toggleSlotTimer(slotKey, am)}
                                disabled={!!am.timeoutTeam}
                                title={am.timeoutTeam ? "Match timer is paused during a timeout" : ""}
                            >
                                {running ? "⏸ Pause" : (elapsed ? "▶ Resume" : "▶ Start")}
                            </button>
                        )}
                        {onPatchSlot && (
                            <button
                                className="btn btn-secondary"
                                onClick={() => {
                                    if (!confirm("Reset the match timer to " + matchDurationMin + " min? Any active timeout will be cleared.")) return;
                                    onPatchSlot(slotKey, {
                                        timerRunning: false,
                                        timerStartAt: null,
                                        timerAccumMs: 0,
                                        timeoutTeam: null,
                                        timeoutStartAt: null,
                                    });
                                }}
                            >Reset timer</button>
                        )}
                        {onDismissSlot && (
                            <button
                                className="btn btn-secondary"
                                onClick={() => onDismissSlot(slotKey)}
                                title="Clear this live match without recording it"
                            >Clear live match</button>
                        )}
                    </div>
                )}
            </>
        );
    };

    return (
        <div className={`card live-card ${expanded ? "expanded" : "collapsed"}`}>
            <div
                className="live-head live-head-clickable"
                onClick={() => setExpanded(x => !x)}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(x => !x); } }}
                aria-expanded={expanded}
            >
                <span className="live-badge"><span className="live-dot"></span>LIVE</span>
                <div className="live-title">
                    <h2>{tournament.name}</h2>
                    <span className="live-sub">
                        Tournament · {formatDate(tournament.date)}
                        {multi && ` · ${slots.length} courts live`}
                    </span>
                </div>
                <span className="live-chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
            </div>

            {!expanded && (
                <div className="live-brief-list">
                    {slots.map(({ match, slotKey }) => (
                        <LiveMatchSummary key={slotKey} tournament={tournament} match={match} />
                    ))}
                </div>
            )}

            {expanded && !multi && (
                <>
                    {slots.map((slot) => (
                        <React.Fragment key={slot.slotKey}>
                            {renderSlot(slot)}
                        </React.Fragment>
                    ))}
                </>
            )}

            {expanded && multi && (
                <>
                    <div
                        className="live-carousel"
                        ref={carouselRef}
                        onScroll={onCarouselScroll}
                        role="group"
                        aria-roledescription="carousel"
                        aria-label={`${slots.length} live matches — swipe to switch`}
                    >
                        {slots.map((slot, i) => (
                            <div
                                key={slot.slotKey}
                                className="live-slide"
                                role="group"
                                aria-roledescription="slide"
                                aria-label={`Match ${i + 1} of ${slots.length}`}
                            >
                                {renderSlot(slot)}
                            </div>
                        ))}
                    </div>
                    <div className="live-pager">
                        <button
                            type="button"
                            className="live-pager-arrow"
                            onClick={() => scrollToSlide(Math.max(0, activeIdx - 1))}
                            disabled={activeIdx === 0}
                            aria-label="Previous match"
                        >‹</button>
                        <div className="live-pager-dots" role="tablist">
                            {slots.map((_, i) => (
                                <button
                                    key={i}
                                    type="button"
                                    className={`live-pager-dot${i === activeIdx ? " active" : ""}`}
                                    onClick={() => scrollToSlide(i)}
                                    role="tab"
                                    aria-selected={i === activeIdx}
                                    aria-label={`Match ${i + 1}`}
                                />
                            ))}
                        </div>
                        <button
                            type="button"
                            className="live-pager-arrow"
                            onClick={() => scrollToSlide(Math.min(slots.length - 1, activeIdx + 1))}
                            disabled={activeIdx === slots.length - 1}
                            aria-label="Next match"
                        >›</button>
                    </div>
                    <div className="live-pager-label">Match {activeIdx + 1} of {slots.length}</div>
                </>
            )}

            {expanded && (
                <>
                    {recentMatches.length > 0 && (
                        <>
                            <h3 className="live-section-title">Last {recentMatches.length} match{recentMatches.length === 1 ? "" : "es"}</h3>
                            <div className="match-list">
                                {recentMatches.map((m, i) => (
                                    <TournamentMatchCard
                                        key={m.id || i}
                                        match={m}
                                        teams={teams}
                                        index={allMatches.length - 1 - i}
                                    />
                                ))}
                            </div>
                        </>
                    )}
                    {onViewTournament && (
                        <div className="btn-row">
                            <button className="btn" onClick={() => onViewTournament(tournament.id)}>
                                View Tournament →
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

function App() {
    const stored = loadState();
    const initial = stored || {
        rosters: [{ id: uid(), name: "Volleyball Group", members: [], sessions: [], currentSession: null }],
        activeRosterId: null,
        tournaments: [],
    };
    if (!initial.activeRosterId && initial.rosters.length > 0) {
        initial.activeRosterId = initial.rosters[0].id;
    }
    if (!Array.isArray(initial.tournaments)) initial.tournaments = [];
    if (!Array.isArray(initial.rosterTemplates)) initial.rosterTemplates = [];

    const [rosters, setRosters] = useState(initial.rosters);
    const [activeRosterId, setActiveRosterId] = useState(initial.activeRosterId);
    const [tournaments, setTournaments] = useState(initial.tournaments);
    const [rosterTemplates, setRosterTemplates] = useState(initial.rosterTemplates);
    const [section, setSection] = useState("live");
    const [tournamentTab, setTournamentTab] = useState("standings");
    const [selectedTournamentId, setSelectedTournamentId] = useState(null);
    const [toast, setToast] = useState(null);
    const [user, setUser] = useState(null);
    const [authReady, setAuthReady] = useState(false);
    const [cloudReady, setCloudReady] = useState(false);
    // Last payload we know matches Firestore — prevents snapshot↔save loops.
    const lastSyncedRef = useRef(null);

    // Track sign-in state
    useEffect(() => {
        return auth.onAuthStateChanged(u => {
            setUser(u);
            setAuthReady(true);
            if (!u) {
                setCloudReady(false);
                lastSyncedRef.current = null;
            }
        });
    }, []);

    // Subscribe to the admin's Firestore doc — same for everyone (public read).
    useEffect(() => {
        const docRef = db.collection("users").doc(ADMIN_UID);
        const unsub = docRef.onSnapshot(snap => {
            console.log("[cloud] snapshot", {
                exists: snap.exists,
                fromCache: snap.metadata.fromCache,
                hasPendingWrites: snap.metadata.hasPendingWrites,
            });
            const data = snap.exists ? snap.data() : null;
            if (!data?.state) { setCloudReady(true); return; }
            const decoded = decodeStateFromCloud(data.state);
            const normalized = normalizeState(decoded);
            if (!normalized) { setCloudReady(true); return; }
            const serialized = JSON.stringify(normalized);
            if (serialized !== lastSyncedRef.current) {
                console.log("[cloud] applying snapshot. activeRosterId:",
                    normalized.activeRosterId,
                    "rosters:",
                    normalized.rosters.map(r => ({
                        name: r.name, id: r.id,
                        members: r.members?.length ?? 0,
                        sessions: r.sessions?.length ?? 0,
                    })));
                lastSyncedRef.current = serialized;
                setRosters(normalized.rosters);
                setActiveRosterId(normalized.activeRosterId);
                setTournaments(normalized.tournaments || []);
                setRosterTemplates(normalized.rosterTemplates || []);
            } else {
                console.log("[cloud] snapshot matches local — ignored");
            }
            setCloudReady(true);
        }, err => {
            console.error("[cloud] sync error:", err);
            setToast("Cloud sync error: " + (err?.message || err));
        });
        return unsub;
    }, []);

    // Save: localStorage always; Firestore only when signed in AS admin (debounced).
    useEffect(() => {
        saveState({ rosters, activeRosterId, tournaments, rosterTemplates });
        const canWrite = user?.uid === ADMIN_UID || isScorerUid(user?.uid);
        if (!canWrite || !cloudReady) {
            console.log("[cloud] skip write — gate failed", {
                uid: user?.uid, canWrite, cloudReady,
            });
            return;
        }
        const payload = { rosters, activeRosterId, tournaments, rosterTemplates };
        const serialized = JSON.stringify(payload);
        if (serialized === lastSyncedRef.current) {
            console.log("[cloud] skip write — unchanged");
            return;
        }
        console.log("[cloud] write scheduled — sessions in roster[0]:",
            payload.rosters.find(r => r.id === payload.activeRosterId)?.sessions?.length);
        const t = setTimeout(() => {
            lastSyncedRef.current = serialized;
            const encoded = encodeStateForCloud(payload);
            console.log("[cloud] writing now", encoded);
            db.collection("users").doc(ADMIN_UID).set({
                state: encoded,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            }, { merge: true })
                .then(() => console.log("[cloud] write OK"))
                .catch(err => {
                    console.error("[cloud] write FAILED:", err);
                    setToast("Save failed: " + (err?.message || err));
                });
        }, 500);
        return () => clearTimeout(t);
    }, [rosters, activeRosterId, tournaments, rosterTemplates, user, cloudReady]);

    const signIn = () => auth.signInWithPopup(googleProvider)
        .catch(err => alert("Sign-in failed: " + err.message));
    const signOut = () => auth.signOut();

    const isAdmin = user?.uid === ADMIN_UID;
    const isScorer = isScorerUid(user?.uid);

    const navigateToTournament = (tournamentId) => {
        setSelectedTournamentId(tournamentId);
        setTournamentTab("standings");
        setSection("tournament");
    };

    const activeRoster = rosters.find(r => r.id === activeRosterId) || rosters[0];

    const exportBackup = () => {
        const payload = {
            kind: "volleyball-organizer-backup",
            version: 4,
            exportedAt: new Date().toISOString(),
            rosters,
            activeRosterId,
            tournaments,
            rosterTemplates,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const dateStr = new Date().toISOString().slice(0, 10);
        a.download = `volleyball-organizer-backup-${dateStr}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setToast("Backup downloaded");
    };

    const importBackup = () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";
        input.onchange = (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                let parsed;
                try {
                    parsed = JSON.parse(reader.result);
                } catch {
                    alert("That file isn't valid JSON.");
                    return;
                }
                const normalized = normalizeState(parsed);
                if (!normalized) {
                    alert("That file doesn't look like a valid Volleyball Organizer backup.");
                    return;
                }
                const n = normalized.rosters.length;
                const totalSessions = normalized.rosters.reduce((s, r) => s + r.sessions.length, 0);
                const totalMembers = normalized.rosters.reduce((s, r) => s + r.members.length, 0);
                if (!confirm(
                    `Restore from backup?\n\n` +
                    `This REPLACES all current data with:\n` +
                    `• ${n} roster${n === 1 ? "" : "s"}\n` +
                    `• ${totalMembers} players\n` +
                    `• ${totalSessions} saved session${totalSessions === 1 ? "" : "s"}\n\n` +
                    `Export a backup of your current data first if you want to keep it.`
                )) return;
                setRosters(normalized.rosters);
                setActiveRosterId(normalized.activeRosterId);
                setTournaments(normalized.tournaments || []);
                setRosterTemplates(normalized.rosterTemplates || []);
                setToast("Backup restored");
            };
            reader.readAsText(file);
        };
        input.click();
    };

    return (
        <div className="app">
            <div className="sticky-top">
            <header>
                <div className="logo">
                    <div className="logo-mark">
                        <svg viewBox="0 0 32 32" fill="none" stroke="#0a0d13" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="16" cy="16" r="12" fill="#fff" stroke="#0a0d13" strokeWidth="2.2"/>
                            <path d="M16 4c-3 4-4.5 9-3 12s5 6 10 7" />
                            <path d="M28 16c-4-1-9 0-12 2s-5 6-4 10" />
                            <path d="M16 28c0-5 2-9 5-11s7-2 11-1" />
                        </svg>
                    </div>
                    <div className="logo-text">
                        <span className="logo-title">Volleyball Club</span>
                    </div>
                </div>
                {authReady && (
                    <div className="auth-chip">
                        {user ? (
                            <>
                                {isAdmin && (
                                    <>
                                        <button className="btn btn-secondary" onClick={exportBackup} title="Download all data as JSON">Backup</button>
                                        <button className="btn btn-secondary" onClick={importBackup} title="Restore from a backup file">Restore</button>
                                    </>
                                )}
                                {user.photoURL && <img src={user.photoURL} alt="" className="avatar" referrerPolicy="no-referrer" title={user.email} />}
                                <button className="btn btn-secondary" onClick={signOut}>Sign out</button>
                            </>
                        ) : (
                            <button className="btn" onClick={signIn}>Sign in</button>
                        )}
                    </div>
                )}
            </header>

            <nav className="section-nav">
                <button
                    className={section === "live" ? "active" : ""}
                    onClick={() => setSection("live")}
                >Live</button>
                <button
                    className={section === "tournament" ? "active" : ""}
                    onClick={() => setSection("tournament")}
                >Tournament</button>
            </nav>
            </div>

            {section === "live" ? (
                <LiveView
                    key={activeRoster?.id + "-live"}
                    tournaments={tournaments}
                    setTournaments={isAdmin || isScorer ? setTournaments : null}
                    onViewTournament={navigateToTournament}
                    showToast={setToast}
                />
            ) : (
                <TournamentView
                    tournaments={tournaments}
                    setTournaments={isAdmin || isScorer ? setTournaments : () => {}}
                    rosterTemplates={rosterTemplates}
                    setRosterTemplates={isAdmin ? setRosterTemplates : null}
                    showToast={setToast}
                    canManage={isAdmin}
                    canScore={isAdmin || isScorer}
                    tournamentTab={tournamentTab}
                    setTournamentTab={setTournamentTab}
                    selectedTournamentId={selectedTournamentId}
                    setSelectedTournamentId={setSelectedTournamentId}
                    scorerKey={user?.uid || "anonymous"}
                />
            )}

            {toast && <Toast message={toast} onDone={() => setToast(null)} />}
        </div>
    );
}

class ErrorBoundary extends React.Component {
    constructor(props) { super(props); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error }; }
    componentDidCatch(error, info) { console.error("App error:", error, info); }
    render() {
        if (this.state.error) {
            return (
                <div className="app">
                    <div className="card">
                        <h2 style={{ color: "var(--danger)" }}>Something went wrong</h2>
                        <pre style={{
                            background: "var(--surface-2)",
                            padding: "0.75rem",
                            borderRadius: "8px",
                            whiteSpace: "pre-wrap",
                            fontSize: "0.85rem",
                            color: "var(--text-dim)",
                        }}>
                            {String(this.state.error?.stack || this.state.error)}
                        </pre>
                        <div className="btn-row">
                            <button className="btn btn-danger" onClick={() => {
                                if (confirm("Clear all saved data and reload?")) {
                                    localStorage.removeItem(STORAGE_KEY);
                                    localStorage.removeItem(LEGACY_KEY_V2);
                                    location.reload();
                                }
                            }}>Clear data & reload</button>
                        </div>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<ErrorBoundary><App /></ErrorBoundary>);
