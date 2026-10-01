import { state, stats } from "./state.mjs";

export function analytics() {
  const ranking = stats();
  const by = ranking.map(c => ({
    contestant: c.no,
    name: c.displayName || c.name,
    votes: c.votes
  }));
  return {
    totalVotes: state.totalAcceptedVotes,
    uniqueVoters: state.uniqueVoters,
    byContestant: by,
    last24h: state.totalAcceptedVotes,
    hourly: []
  };
}
