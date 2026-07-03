import { parseUnifiedDiff } from './src/server/core/diff.ts';

const files = [
  { path: 'src/one.ts', content: 'console.log(1);' },
  { path: 'src/two.ts', content: 'console.log(2);' },
  { path: 'src/three.ts', content: 'console.log(3);' },
];

const mockDiff = files.map((f) => {
      const lines = f.content.split('\n');
      return `diff --git a/${f.path} b/${f.path}
index 1234567..890abcd 100644
--- a/${f.path}
+++ b/${f.path}
@@ -1,${lines.length} +1,${lines.length} @@
${lines.map((l) => `+${l}`).join('\n')}`;
    }).join('\n');

console.log(JSON.stringify(parseUnifiedDiff(mockDiff), null, 2));
