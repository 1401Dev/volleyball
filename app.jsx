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
// ---------------------------------------------------------------------------

const STORAGE_KEY = "volleyball-organizer-v3";
const LEGACY_KEY_V2 = "volleyball-organizer-v2";

const PRESET_ROSTER = [
    // Category 1
    { name: "Dharmeshbhai", category: 1, rank: 1 },
    { name: "Jaybhai",      category: 1, rank: 2 },
    { name: "Onibhai",      category: 1, rank: 3 },
    { name: "Rushik",       category: 1, rank: 4 },
    { name: "Shiv",         category: 1, rank: 5 },
    { name: "Dev",          category: 1, rank: 6 },
    { name: "Shivang",    category: 1, rank: 7 },
    { name: "Anvinbhai",      category: 1, rank: 8 },
    // Category 2
    { name: "Mihirbhai",    category: 2, rank: 1 },
    { name: "Ashishbhai",   category: 2, rank: 2 },
    { name: "Darshan",      category: 2, rank: 3 },
    { name: "Jimmybhai",    category: 2, rank: 4 },
    { name: "Rupeshbhai",   category: 2, rank: 5 },
    { name: "Primalbhai",   category: 2, rank: 6 },
    { name: "Harshalbhai",  category: 2, rank: 7 },
    { name: "Hirenbhai",    category: 2, rank: 8 },
    // Category 3
    { name: "Nayanbhai",    category: 3, rank: 1 },
    { name: "Sameerbhai",   category: 3, rank: 2 },
    { name: "Samirbhai",    category: 3, rank: 3 },
    { name: "Atulbhai",     category: 3, rank: 4 },
    { name: "Vijaybhai",    category: 3, rank: 5 },
    { name: "Pranaybhai",   category: 3, rank: 6 },
    { name: "Vipulbhai",    category: 3, rank: 7 },
    { name: "Pareshbhai",   category: 3, rank: 8 },
    { name: "Arpanbhai",    category: 3, rank: 9 },
    { name: "Anilbhai",     category: 3, rank: 10 },
];

const uid = () => Math.random().toString(36).slice(2, 10);
const seedRoster = () => PRESET_ROSTER.map(p => ({ id: uid(), ...p }));

const makeRoster = (name, members = []) => ({
    id: uid(),
    name,
    members,
    sessions: [],
    currentSession: null,
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
        const activeRosterId = rosters.some(r => r.id === parsed.activeRosterId)
            ? parsed.activeRosterId
            : rosters[0].id;
        return { rosters, activeRosterId };
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
                members: Array.isArray(old.members) && old.members.length ? old.members : seedRoster(),
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

function ThisWeekView({ members, currentSession, setCurrentSession, saveSession, showToast }) {
    const [date, setDate] = useState(currentSession?.date || nextFriday());
    const [filter, setFilter] = useState("all");
    const [selectedPlayer, setSelectedPlayer] = useState(null); // { playerId, fromTeamIdx }
    const [dragOverTeam, setDragOverTeam] = useState(null);

    // Move a player and insert at an exact position. If toIdx is null, append.
    // Correctly handles same-team moves (index shift after removal).
    const movePlayerTo = (playerId, fromTeamIdx, toTeamIdx, toIdx) => {
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
        if (selectedPlayer?.playerId === playerId) {
            setSelectedPlayer(null);
        } else if (selectedPlayer) {
            swapPlayers(selectedPlayer.playerId, selectedPlayer.fromTeamIdx, playerId, teamIdx);
        } else {
            setSelectedPlayer({ playerId, fromTeamIdx: teamIdx });
        }
    };

    const handleTeamTap = (teamIdx) => {
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
            locked: false
        });
    };

    const toggleOut = (memberId) => {
        if (!currentSession || currentSession.locked) return;
        const available = currentSession.available.includes(memberId)
            ? currentSession.available.filter(id => id !== memberId)
            : [...currentSession.available, memberId];
        setCurrentSession({ ...currentSession, available, teams: null });
    };

    const markAllIn = () => {
        setCurrentSession({ ...currentSession, available: members.map(m => m.id), teams: null });
    };
    const markAllOut = () => {
        setCurrentSession({ ...currentSession, available: [], teams: null });
    };

    const generateTeams = () => {
        if (!currentSession) return;
        const availablePlayers = members.filter(m => currentSession.available.includes(m.id));
        const numTeams = availablePlayers.length >= 17 ? 3 : 2;
        const teams = generateBalancedTeams(availablePlayers, numTeams).map(team => team.map(p => p.id));
        setCurrentSession({ ...currentSession, teams });
        setSelectedPlayer(null);
        showToast(`${numTeams} teams generated`);
    };

    const lockAndSave = () => {
        if (!currentSession?.teams) return;
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
            <div className="card">
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
                        disabled={currentSession.available.length < 3}
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
            </div>

            {currentSession.teams && (
                <div className="card">
                    <h2>Teams</h2>
                    {selectedPlayer && (() => {
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
                            const droppable = selectedPlayer != null && selectedPlayer.fromTeamIdx !== i;
                            const dragOver = dragOverTeam === i;
                            return (
                                <div
                                    key={i}
                                    className={`team team-${i + 1} ${droppable ? "droppable" : ""} ${dragOver ? "drag-over" : ""}`}
                                    onClick={() => handleTeamTap(i)}
                                    onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragOverTeam !== i) setDragOverTeam(i); }}
                                    onDragLeave={e => {
                                        if (!e.currentTarget.contains(e.relatedTarget)) setDragOverTeam(null);
                                    }}
                                    onDrop={e => {
                                        e.preventDefault();
                                        setDragOverTeam(null);
                                        try {
                                            const data = JSON.parse(e.dataTransfer.getData("application/json"));
                                            movePlayerTo(data.playerId, data.fromTeamIdx, i, null);
                                        } catch {}
                                    }}
                                >
                                    <div className="team-header">
                                        <div className="jersey">{String.fromCharCode(65 + i)}</div>
                                        <div className="team-title">
                                            <span className="name">Team {String.fromCharCode(65 + i)}</span>
                                            <span className="meta">{team.length} Players</span>
                                        </div>
                                    </div>
                                    <div className="team-players">
                                        {team.map((p, playerIdx) => (
                                            <div
                                                key={p.id}
                                                className={`team-player ${selectedPlayer?.playerId === p.id ? "selected" : ""}`}
                                                draggable
                                                onDragStart={e => {
                                                    e.dataTransfer.setData("application/json", JSON.stringify({ playerId: p.id, fromTeamIdx: i }));
                                                    e.dataTransfer.effectAllowed = "move";
                                                    e.currentTarget.classList.add("dragging");
                                                }}
                                                onDragEnd={e => {
                                                    e.currentTarget.classList.remove("dragging");
                                                    e.currentTarget.classList.remove("drop-before", "drop-after");
                                                    setDragOverTeam(null);
                                                }}
                                                onDragOver={e => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    e.dataTransfer.dropEffect = "move";
                                                    const rect = e.currentTarget.getBoundingClientRect();
                                                    const after = (e.clientY - rect.top) > rect.height / 2;
                                                    e.currentTarget.classList.toggle("drop-before", !after);
                                                    e.currentTarget.classList.toggle("drop-after", after);
                                                    if (dragOverTeam !== i) setDragOverTeam(i);
                                                }}
                                                onDragLeave={e => {
                                                    e.currentTarget.classList.remove("drop-before", "drop-after");
                                                }}
                                                onDrop={e => {
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
                                                }}
                                                onClick={e => { e.stopPropagation(); handlePlayerTap(p.id, i); }}
                                            >
                                                <span>{p.name}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    <p className="help-text">
                        Drag a player onto another player to place them at that exact spot (works within the same team too). Drop on empty team space to add to the end. On mobile: tap a player, then tap another player to swap, or tap a team card to move to its end.
                    </p>
                    <div className="btn-row">
                        <button className="btn" onClick={copyTeamsText}>Copy for WhatsApp</button>
                        <button className="btn btn-secondary" onClick={lockAndSave}>Save Session</button>
                    </div>
                </div>
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
                            {s.available.length} players · {s.teams ? `${s.teams.length} teams` : "no teams"}
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
                            {s.available.length} players · {s.teams ? `${s.teams.length} teams` : "no teams"}
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
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}

function App() {
    const stored = loadState();
    const initial = stored || {
        rosters: [{ id: uid(), name: "Volleyball Group", members: seedRoster(), sessions: [], currentSession: null }],
        activeRosterId: null,
    };
    if (!initial.activeRosterId && initial.rosters.length > 0) {
        initial.activeRosterId = initial.rosters[0].id;
    }

    const [rosters, setRosters] = useState(initial.rosters);
    const [activeRosterId, setActiveRosterId] = useState(initial.activeRosterId);
    const [tab, setTab] = useState("week");
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
            const data = snap.exists ? snap.data() : null;
            if (!data?.state) { setCloudReady(true); return; }
            const normalized = normalizeState(data.state);
            if (!normalized) { setCloudReady(true); return; }
            const serialized = JSON.stringify(normalized);
            if (serialized !== lastSyncedRef.current) {
                lastSyncedRef.current = serialized;
                setRosters(normalized.rosters);
                setActiveRosterId(normalized.activeRosterId);
            }
            setCloudReady(true);
        }, err => console.error("Firestore sync error:", err));
        return unsub;
    }, []);

    // Save: localStorage always; Firestore only when signed in AS admin (debounced).
    useEffect(() => {
        saveState({ rosters, activeRosterId });
        if (user?.uid !== ADMIN_UID || !cloudReady) return;
        const payload = { rosters, activeRosterId };
        const serialized = JSON.stringify(payload);
        if (serialized === lastSyncedRef.current) return;
        const t = setTimeout(() => {
            lastSyncedRef.current = serialized;
            db.collection("users").doc(ADMIN_UID).set({
                state: payload,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            }, { merge: true }).catch(err => console.error("Firestore save error:", err));
        }, 500);
        return () => clearTimeout(t);
    }, [rosters, activeRosterId, user, cloudReady]);

    const signIn = () => auth.signInWithPopup(googleProvider)
        .catch(err => alert("Sign-in failed: " + err.message));
    const signOut = () => auth.signOut();

    const isAdmin = user?.uid === ADMIN_UID;

    // Non-admins can't see "This Week"; bounce them to Members.
    useEffect(() => {
        if (!isAdmin && tab === "week") setTab("members");
    }, [isAdmin, tab]);

    const activeRoster = rosters.find(r => r.id === activeRosterId) || rosters[0];

    const patchActive = (updater) => {
        setRosters(prev => prev.map(r => r.id === activeRosterId ? updater(r) : r));
    };

    const setMembers = (members) => patchActive(r => ({ ...r, members }));
    const setCurrentSession = (currentSession) => patchActive(r => ({ ...r, currentSession }));
    const saveSession = (s) => patchActive(r => ({
        ...r,
        sessions: [...r.sessions.filter(x => x.id !== s.id), s],
    }));
    const deleteSession = (id) => patchActive(r => ({
        ...r,
        sessions: r.sessions.filter(s => s.id !== id),
    }));
    const resetToPreset = () => patchActive(r => ({ ...r, members: seedRoster() }));

    const createRoster = () => {
        const name = (prompt("Name for the new roster:") || "").trim();
        if (!name) return;
        if (rosters.some(r => r.name.toLowerCase() === name.toLowerCase())) {
            alert("A roster with that name already exists.");
            return;
        }
        const useBlank = !confirm(`Seed "${name}" with the preset 25-player list?\n(OK = seed, Cancel = start empty)`);
        const newRoster = {
            id: uid(),
            name,
            members: useBlank ? [] : seedRoster(),
            sessions: [],
            currentSession: null,
        };
        setRosters([...rosters, newRoster]);
        setActiveRosterId(newRoster.id);
        setTab("members");
        setToast(`Roster "${name}" created`);
    };

    const renameRoster = () => {
        const name = (prompt("Rename roster:", activeRoster.name) || "").trim();
        if (!name || name === activeRoster.name) return;
        if (rosters.some(r => r.id !== activeRoster.id && r.name.toLowerCase() === name.toLowerCase())) {
            alert("A roster with that name already exists.");
            return;
        }
        updateActive({ name });
        setToast("Roster renamed");
    };

    const deleteRoster = () => {
        if (rosters.length === 1) {
            alert("Can't delete the last roster. Create another one first.");
            return;
        }
        if (!confirm(`Delete roster "${activeRoster.name}" and all its sessions? This can't be undone.`)) return;
        const remaining = rosters.filter(r => r.id !== activeRoster.id);
        setRosters(remaining);
        setActiveRosterId(remaining[0].id);
        setToast("Roster deleted");
    };

    const exportBackup = () => {
        const payload = {
            kind: "volleyball-organizer-backup",
            version: 3,
            exportedAt: new Date().toISOString(),
            rosters,
            activeRosterId,
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
                setToast("Backup restored");
            };
            reader.readAsText(file);
        };
        input.click();
    };

    return (
        <div className="app">
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
                        <span className="logo-title">Sport Club</span>
                        <span className="logo-sub">Team Manager</span>
                    </div>
                </div>
                {authReady && (
                    <div className="auth-chip">
                        {user ? (
                            <>
                                {user.photoURL && <img src={user.photoURL} alt="" className="avatar" referrerPolicy="no-referrer" />}
                                <span className="user-email" title={user.email}>{user.email}</span>
                                <button className="btn btn-secondary" onClick={signOut}>Sign out</button>
                            </>
                        ) : (
                            <button className="btn" onClick={signIn}>Admin sign in</button>
                        )}
                    </div>
                )}
            </header>

            {isAdmin ? (
                <>
                    <div className="roster-bar">
                        <span className="roster-label">Roster</span>
                        <select value={activeRoster.id} onChange={e => setActiveRosterId(e.target.value)}>
                            {rosters.map(r => (
                                <option key={r.id} value={r.id}>{r.name}</option>
                            ))}
                        </select>
                        <button onClick={createRoster} title="New roster">+ New</button>
                        <button onClick={renameRoster} title="Rename this roster">Rename</button>
                        <button className="danger" onClick={deleteRoster} title="Delete this roster">Delete</button>
                        <span className="roster-divider" aria-hidden="true"></span>
                        <button onClick={exportBackup} title="Download all data as a JSON file">Backup</button>
                        <button onClick={importBackup} title="Restore from a backup file">Restore</button>
                    </div>
                    <nav>
                        <button className={tab === "week" ? "active" : ""} onClick={() => setTab("week")}>This Week</button>
                        <button className={tab === "members" ? "active" : ""} onClick={() => setTab("members")}>Members</button>
                        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>History</button>
                    </nav>
                    {tab === "week" && (
                        <ThisWeekView
                            key={activeRoster.id}
                            members={activeRoster.members}
                            currentSession={activeRoster.currentSession}
                            setCurrentSession={setCurrentSession}
                            saveSession={saveSession}
                            showToast={setToast}
                        />
                    )}
                    {tab === "members" && (
                        <MembersView
                            key={activeRoster.id}
                            members={activeRoster.members}
                            setMembers={setMembers}
                            resetToPreset={resetToPreset}
                        />
                    )}
                    {tab === "history" && (
                        <HistoryView
                            key={activeRoster.id}
                            sessions={activeRoster.sessions}
                            members={activeRoster.members}
                            deleteSession={deleteSession}
                        />
                    )}
                </>
            ) : (
                <>
                    <div className="roster-bar">
                        <span className="roster-label">Roster</span>
                        <span className="roster-name-static">{activeRoster?.name || "—"}</span>
                    </div>
                    <nav>
                        <button className={tab === "members" ? "active" : ""} onClick={() => setTab("members")}>Members</button>
                        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>History</button>
                    </nav>
                    {tab === "members" && (
                        <PublicMembersView
                            key={activeRoster?.id}
                            members={activeRoster?.members || []}
                        />
                    )}
                    {tab === "history" && (
                        <PublicHistoryView
                            key={activeRoster?.id}
                            sessions={activeRoster?.sessions || []}
                            members={activeRoster?.members || []}
                        />
                    )}
                </>
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
