// backend/src/lib/sort.js
export function sortAgents(agents) {
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}
