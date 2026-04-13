
const regex = /^([\u{1F300}-\u{1F9FF}]|\[QUALITY\]|\[P[0-3]\]|\[NIT\]|\s|[:\-])+/giu;

const titles = [
  "[P0] Fix syntax error",
  "🔥 [P0] Fix syntax error",
  "🔴 [QUALITY] [P1] Off-by-one",
  "[NIT] Typo",
  "   [P2] Style issue"
];

titles.forEach(t => {
  console.log(`'${t}' -> '${t.replace(regex, "").trim()}'`);
});
