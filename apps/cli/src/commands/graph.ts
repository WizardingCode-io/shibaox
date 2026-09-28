import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Graphify, graphJsonPath } from '@wizardingcode/shibaox-memory';

export interface GraphCommandDeps {
  graphify?: Graphify;
  log?: (line: string) => void;
}

const deps = (d: GraphCommandDeps) => ({
  graphify: d.graphify ?? new Graphify(),
  log: d.log ?? ((l: string) => console.log(l)),
});

/** `shibaox graph build`: installs graphify when possible, then extracts the code graph. */
export async function graphBuild(
  o: { project: string },
  d: GraphCommandDeps = {},
): Promise<number> {
  const { graphify, log } = deps(d);
  const project = resolve(o.project);
  const installed = await graphify.ensureInstalled();
  if (!installed.ok) {
    log(installed.message);
    return 1;
  }
  const r = await graphify.build(project);
  log(r.message);
  if (r.graphJson) log(`graph: ${r.graphJson}`);
  return r.ok ? 0 : 1;
}

/** `shibaox graph update`: refreshes an existing graph after code changes. */
export async function graphUpdate(
  o: { project: string },
  d: GraphCommandDeps = {},
): Promise<number> {
  const { graphify, log } = deps(d);
  const r = await graphify.update(resolve(o.project));
  log(r.message);
  return r.ok ? 0 : 1;
}

/** `shibaox graph query "<q>"`: answers a question from the project's graph. */
export async function graphQuery(
  question: string,
  o: { project: string; budget?: number },
  d: GraphCommandDeps = {},
): Promise<number> {
  const { graphify, log } = deps(d);
  const project = resolve(o.project);
  const graphJson = graphJsonPath(project);
  if (!existsSync(graphJson)) {
    log(`no graph at ${graphJson}: run shibaox graph build --project ${project}`);
    return 1;
  }
  const text = await graphify.query(project, question, o.budget);
  log(text);
  return text.startsWith('graph query failed') ? 1 : 0;
}
