import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('keeps all seven frozen reference blocks identical to their single source files', async () => {
  const document = await readFile('design/WebPulse-项目技术文档.md', 'utf8');
  const blocks = [
    ...document.matchAll(/<!-- file: (reference\/[\w./-]+) -->\r?\n```[^\n]*\n([\s\S]*?)\r?\n```/g),
  ];
  expect(blocks).toHaveLength(7);
  expect(new Set(blocks.map((match) => match[1])).size).toBe(7);
  for (const block of blocks) {
    const source = await readFile(`design/${block[1]}`, 'utf8');
    expect(block[2]!.replaceAll('\r\n', '\n').trimEnd(), block[1]).toBe(
      source.replaceAll('\r\n', '\n').trimEnd(),
    );
  }
});
