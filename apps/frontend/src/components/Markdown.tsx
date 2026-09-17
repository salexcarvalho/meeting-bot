import { Fragment, type ReactNode } from "react";

// Markdown mínimo (títulos, listas, negrito, itálico, código) renderizado como
// elementos React — nunca como HTML cru. "[mm:ss]" (momento na gravação) vira marcador discreto.
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|(?<![\w*])[*_]([^*_]+)[*_](?![\w*])|\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    const index = m.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    if (m[1] !== undefined) out.push(<code key={key++}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={key++}>{m[2]}</strong>);
    else if (m[3] !== undefined) out.push(<em key={key++}>{m[3]}</em>);
    else out.push(<span key={key++} className="ts" title="Momento na gravação">{m[4]}</span>);
    last = index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const PROPOSED = /_?\(proposto\)_?/;

function lineContent(text: string): ReactNode {
  // "(proposto)" destaca itens ainda não revisados.
  const m = PROPOSED.exec(text);
  if (!m) return inline(text);
  return (
    <>
      {inline(text.slice(0, m.index))}
      <span className="proposed">(proposto)</span>
      {inline(text.slice(m.index + m[0].length))}
    </>
  );
}

export function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: ReactNode[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(<Tag key={blocks.length}>{list.items}</Tag>);
    list = null;
  };
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flush();
      const level = Math.min(m[1].length + 1, 5);
      const Tag = `h${level}` as "h2";
      blocks.push(<Tag key={blocks.length}>{inline(m[2])}</Tag>);
    } else if ((m = line.match(/^\s*[-*]\s+(?:\[([ xX])\]\s+)?(.*)$/))) {
      if (!list || list.ordered) {
        flush();
        list = { ordered: false, items: [] };
      }
      const box = m[1] === undefined ? null : m[1] === " " ? "☐ " : "☑ ";
      list.items.push(
        <li key={list.items.length}>
          {box}
          {lineContent(m[2])}
        </li>,
      );
    } else if (/^-{3,}$/.test(line.trim())) {
      flush();
      blocks.push(<hr key={blocks.length} />);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flush();
      blocks.push(<blockquote key={blocks.length}>{lineContent(m[1])}</blockquote>);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (!list || !list.ordered) {
        flush();
        list = { ordered: true, items: [] };
      }
      list.items.push(<li key={list.items.length}>{lineContent(m[1])}</li>);
    } else {
      flush();
      if (line.trim()) blocks.push(<p key={blocks.length}>{lineContent(line)}</p>);
    }
  }
  flush();
  return <div className="markdown">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}
