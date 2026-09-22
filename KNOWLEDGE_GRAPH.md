# Repository knowledge graph

The repository graph provides small, task-specific context packs for humans and
LLMs. It complements Nx's project graph with tracked files, exported TypeScript
symbols, imports, tests, documentation, and instruction files.

The generated graph is local and disposable. It is written to
`.repo-graph/graph.json`, which is ignored by Git.

## Build and query

```bash
bun run graph:build
bun run graph:query niivue
bun run graph:query OmeZarr --depth=2 --max-nodes=40
bun run graph:query packages/niivue/src/volume/omeZarrLoader.ts
bun run graph:query "chunk residency manager"
```

A query matches node IDs, names, paths, and summaries. It then walks nearby
edges and prints a compact Markdown context pack. Exact matches rank above
substring matches, and lower graph depth keeps the result focused. A
multi-word query is an AND over its terms, so descriptive phrases find nodes
whose name you don't know. The query warns when the graph was built at a
different revision than HEAD.

Useful options:

```text
--depth=N       Maximum relationship hops (default 1)
--max-nodes=N   Maximum nodes in the context pack (default 30)
--json          Emit the selected subgraph as JSON
```

## Graph model

Nodes have stable IDs and one of these kinds:

- `project`: an Nx project, including tags, root, and available targets
- `file`: a tracked source, shader (`.wgsl`), demo (`.html`), configuration,
  test, documentation, or instruction file
- `symbol`: an exported TypeScript class, interface, type, enum, function, or constant

Edges use these relationships:

- `depends_on`: Nx project dependency
- `contains`: project-to-file and file-to-symbol ownership
- `imports`: a source-file import. Relative and `@/`-aliased specifiers
  resolve to the target file; workspace package specifiers (`@niivue/...`)
  resolve to the target project. Vite query suffixes (`?raw`,
  `?worker&inline`) are stripped before resolution.
- `tests`: a test file targeting its corresponding source file
- `documents`: README/instruction files describing their project or directory

File summaries come from the leading comment (block or `//` paragraph), a
Markdown H1, or an HTML `<title>`.

The graph intentionally does not embed source bodies. Its purpose is routing:
identify the smallest relevant files and relationships first, then open only
those files. This can reduce context use, but only when an agent or tool queries
the graph before broad repository searches.

## Maintenance

Rebuild after changing project configuration, imports, exported symbols, tests,
or documentation. The output is deterministic for a given checkout and should
not be committed.
