import rough from "roughjs";
import type { Drawable, Options } from "roughjs/bin/core.js";
import type { RoughGenerator } from "roughjs/bin/generator.js";

interface Measured {
  name: string;
  size: number;
  encode: number;
  decode: number;
}

type Row = Measured | { name: string; note: string };

const themes = {
  light: {
    text: "#1f2328",
    muted: "#59636e",
    line: "#afb8c1",
    size: { fill: "#9aa7b5", stroke: "#5f6b78" },
    encode: { fill: "#67b7dc", stroke: "#2f7fae" },
    decode: { fill: "#f5c400", stroke: "#b08c00" }
  },
  dark: {
    text: "#f0f6fc",
    muted: "#9198a1",
    line: "#656c76",
    size: { fill: "#8b97a5", stroke: "#c3ccd6" },
    encode: { fill: "#4fa3cf", stroke: "#a3d6f2" },
    decode: { fill: "#d9ad00", stroke: "#ffdc5c" }
  }
};

const width = 780;
const nameWidth = 132;
const sizeWidth = 220;
const gap = 40;
const speedWidth = width - nameWidth - sizeWidth - gap - 12;
const labelRoom = 62;
const top = 78;
const rowHeight = 34;
const barHeight = 12;
const font = `font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"`;

/* Seeding each shape keeps the hand-drawn wobble identical between runs, so regenerated charts only differ where the numbers do */
export function benchmarkChart(title: string, subtitle: string, rows: Row[], formatTime: (nanoseconds: number) => string, theme: keyof typeof themes): string {
  const colours = themes[theme];
  const generator = (rough as unknown as { generator(): RoughGenerator }).generator();
  const height = top + rows.length * rowHeight + 8;
  const sizeLeft = nameWidth;
  const speedLeft = nameWidth + sizeWidth + gap;
  const measured = rows.filter((row): row is Measured => !("note" in row));
  const maxSize = Math.max(...measured.map(row => row.size));
  const maxTime = Math.max(...measured.flatMap(row => [row.encode, row.decode]));
  const sizeBar = (value: number) => Math.max(2, (value / maxSize) * (sizeWidth - labelRoom));
  const timeBar = (value: number) => Math.max(2, (value / maxTime) * (speedWidth - labelRoom));
  const parts: string[] = [];
  let seed = 1;

  const draw = (shape: Drawable) => {
    for (const path of generator.toPaths(shape)) {
      const d = path.d.replace(/-?\d+\.\d+/g, (number: string) => String(Math.round(Number(number) * 10) / 10));
      parts.push(`<path d="${d}" stroke="${path.stroke}" stroke-width="${path.strokeWidth}" fill="${path.fill ?? "none"}"/>`);
    }
  };
  const box = (x: number, y: number, w: number, h: number, colour: { fill: string; stroke: string }) => {
    const options: Options = { seed: seed++, fill: colour.fill, fillStyle: "hachure", hachureGap: 3, fillWeight: 1.2, disableMultiStrokeFill: true, stroke: colour.stroke, strokeWidth: 1.2, roughness: 1 };
    draw(generator.rectangle(x, y, w, h, options));
  };
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    draw(generator.line(x1, y1, x2, y2, { seed: seed++, stroke: colours.line, strokeWidth: 1, roughness: 0.8 }));
  };
  const text = (x: number, y: number, content: string, size: number, colour: string, extra: string) => {
    parts.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${colour}"${extra}>${content}</text>`);
  };

  text(14, 26, title, 17, colours.text, ` font-weight="600"`);
  text(14, 46, subtitle, 12, colours.muted, "");
  text(sizeLeft, top - 12, "Size in bytes", 12, colours.muted, "");
  text(speedLeft, top - 12, "Time per message", 12, colours.muted, "");
  for (const [index, key] of (["encode", "decode"] as const).entries()) {
    const x = width - 166 + index * 80;
    box(x, top - 23, 14, 12, colours[key]);
    text(x + 20, top - 12, key == "encode" ? "Encode" : "Decode", 12, colours.muted, "");
  }
  line(sizeLeft, top - 4, sizeLeft, height - 4);
  line(speedLeft, top - 4, speedLeft, height - 4);

  rows.forEach((row, index) => {
    const y = top + index * rowHeight;
    text(nameWidth - 12, y + 19, row.name, 13, colours.text, ` text-anchor="end"${index == 0 ? ` font-weight="600"` : ""}`);
    if ("note" in row) {
      text(sizeLeft + 8, y + 19, row.note, 12, colours.muted, ` font-style="italic"`);
      text(speedLeft + 8, y + 19, row.note, 12, colours.muted, ` font-style="italic"`);
      return;
    }
    box(sizeLeft, y + 7, sizeBar(row.size), barHeight + 4, colours.size);
    text(sizeLeft + sizeBar(row.size) + 7, y + 19, String(row.size), 11, colours.text, "");
    for (const [bar, key] of (["encode", "decode"] as const).entries()) {
      const barY = y + 3 + bar * (barHeight + 3);
      box(speedLeft, barY, timeBar(row[key]), barHeight, colours[key]);
      text(speedLeft + timeBar(row[key]) + 7, barY + 10, formatTime(row[key]), 10.5, colours.text, "");
    }
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ${font}>\n${parts.join("\n")}\n</svg>\n`;
}
