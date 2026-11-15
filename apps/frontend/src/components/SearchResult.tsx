import { useState } from "react";
import { Link } from "react-router";
import { SEARCH_KIND_LABELS, type SearchHitValue } from "@meeting-bot/contracts";
import { formatDate } from "../format";
import { groupByMeeting, keyedSnippet, matchedByLabel, targetPath, type MeetingGroup } from "../searchUi";

const HITS_PER_MEETING = 3;

/** Trecho montado a partir de partes (nunca HTML): o que casou vai em <mark>. */
export function Snippet({ parts }: { parts: SearchHitValue["snippet"] }) {
  return (
    <>
      {keyedSnippet(parts).map((part) => (part.match ? <mark key={part.key}>{part.text}</mark> : <span key={part.key}>{part.text}</span>))}
    </>
  );
}

export function HitBadges({ hit, showMatch = true }: { hit: SearchHitValue; showMatch?: boolean }) {
  const reviewed = hit.kind === "item" || hit.kind === "adr" ? hit.reviewStatus : null;
  return (
    <span className="search-badges">
      <span className="badge info">{SEARCH_KIND_LABELS[hit.kind]}</span>
      {reviewed === "proposto" && <span className="badge warn">proposto</span>}
      {reviewed === "rejeitado" && <span className="badge">rejeitado</span>}
      {showMatch && <span className="search-match muted">{matchedByLabel(hit.matchedBy)}</span>}
    </span>
  );
}

export function SearchHitRow({ hit, showMeeting = false }: { hit: SearchHitValue; showMeeting?: boolean }) {
  return (
    <li className="search-hit">
      <HitBadges hit={hit} />
      <Link className="search-hit-link" to={targetPath(hit.target)}>
        {showMeeting && <span className="search-hit-meeting">{hit.meeting.title} · {formatDate(hit.meeting.date)}</span>}
        {hit.speaker && <span className="speaker">{hit.speaker}</span>}
        <Snippet parts={hit.snippet} />
      </Link>
    </li>
  );
}

/** Uma reunião com seus trechos: três de início e "ver mais" para o resto. */
export function SearchResult({ group }: { group: MeetingGroup }) {
  const [expanded, setExpanded] = useState(false);
  const { meeting, hits } = group;
  const extra = hits.length - HITS_PER_MEETING;
  const visible = expanded ? hits : hits.slice(0, HITS_PER_MEETING);
  return (
    <article className="search-group card">
      <header className="search-group-head">
        <h2>
          <Link to={`/reunioes/${meeting.id}`}>{meeting.title}</Link>
        </h2>
        <span className="small muted">
          {formatDate(meeting.date)}
          {meeting.project ? ` · ${meeting.project.name}` : ""}
        </span>
      </header>
      <ul className="search-hits">
        {visible.map((hit) => (
          <SearchHitRow key={hit.id} hit={hit} />
        ))}
      </ul>
      {extra > 0 && (
        <button type="button" className="link small" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Ver menos" : `Ver mais ${extra} ${extra === 1 ? "trecho" : "trechos"} desta reunião`}
        </button>
      )}
    </article>
  );
}

export function SearchResultList({ hits }: { hits: SearchHitValue[] }) {
  return (
    <div className="search-results">
      {groupByMeeting(hits).map((group) => (
        <SearchResult key={group.meeting.id} group={group} />
      ))}
    </div>
  );
}
