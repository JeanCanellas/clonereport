'use strict';
// Community vote math, shared by the pages and the API.
const MIN_VOTES = 3; // below this no verdict is shown

function tally(r) {
  const t = { clone: r.votes_clone || 0, inspired: r.votes_inspired || 0, original: r.votes_original || 0 };
  t.total = t.clone + t.inspired + t.original;
  // Clone score: share of votes saying "clone", with "inspired by" counting half.
  t.score = t.total ? Math.round((100 * (t.clone + t.inspired / 2)) / t.total) : null;
  return t;
}
function verdict(t) {
  if (t.total < MIN_VOTES) return null;
  return t.score >= 67 ? 'Likely a clone' : t.score >= 34 ? 'Inspired by' : 'Likely original';
}
module.exports = { MIN_VOTES, tally, verdict };
