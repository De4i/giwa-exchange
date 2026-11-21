import type { Project } from "@/lib/explorer";

export default function Ecosystem({ projects }: { projects: Project[] }) {
  const categories = new Map<string, number>();
  for (const p of projects) {
    const c = p.category ?? "Other";
    categories.set(c, (categories.get(c) ?? 0) + 1);
  }
  const sortedCats = [...categories.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <section aria-label="Ecosystem">
      <div className="section-head">
        <h2>GIWA ecosystem</h2>
        <span className="muted">
          {projects.length} projects listed on{" "}
          <a href="https://giwa.eco/en/projects" target="_blank" rel="noreferrer">
            giwa.eco
          </a>
        </span>
      </div>
      <div className="chips">
        {sortedCats.map(([k, v]) => (
          <span key={k} className="chip">
            {k} <b>{v}</b>
          </span>
        ))}
      </div>
      <div className="grid">
        {projects.map((p) => (
          <article key={p.slug} className="card">
            <div className="card-name">
              <a href={p.url} target="_blank" rel="noreferrer">
                {p.name}
              </a>
            </div>
            <div className="card-meta">
              {p.category ?? ""}
              {p.x ? ` · @${p.x}` : ""}
              {p.country ? ` · ${p.country}` : ""}
              {p.stage ? ` · ${p.stage}` : ""}
            </div>
            {p.description && <p className="card-desc">{p.description}</p>}
            {p.website && (
              <a className="card-link" href={p.website} target="_blank" rel="noreferrer">
                {p.website.replace(/^https?:\/\//, "")}
              </a>
            )}
          </article>
        ))}
      </div>
      {projects.length === 0 && (
        <p className="muted">Ecosystem data is unavailable right now (giwa.eco could not be read).</p>
      )}
    </section>
  );
}
