import { parseAllDocuments } from 'yaml';

/**
 * A few of the Kubernetes API server's own validation rules, run on manifests in-process, so a patch
 * that would still be rejected on sync ("spec.template.spec.containers: Required value") fails
 * validation here instead of being proposed as a fix.
 */

export interface K8sProblem {
  /** In the API server's wording: `Deployment "x": spec.template.spec.containers: Required value`. */
  message: string;
  /** The required key that is missing (`containers`, `image`), when that is the problem. */
  missing?: string;
}

/** Where each workload kind keeps its pod spec. */
const POD_SPEC: Record<string, string[]> = {
  Pod: ['spec'],
  Deployment: ['spec', 'template', 'spec'],
  StatefulSet: ['spec', 'template', 'spec'],
  DaemonSet: ['spec', 'template', 'spec'],
  ReplicaSet: ['spec', 'template', 'spec'],
  ReplicationController: ['spec', 'template', 'spec'],
  Job: ['spec', 'template', 'spec'],
  CronJob: ['spec', 'jobTemplate', 'spec', 'template', 'spec'],
};

const PROBES = ['startupProbe', 'readinessProbe', 'livenessProbe'];
/** Settings an init container (without restartPolicy: Always) does not normally have: signs of a main container. */
const MAIN_CONTAINER_FIELDS = ['ports', ...PROBES, 'lifecycle'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Problems the API server would reject. Helm/Go templates and unparsable documents are skipped. */
export function k8sProblems(content: string): K8sProblem[] {
  if (content.includes('{{') || !/^(kind|apiVersion):/m.test(content)) return [];
  const problems: K8sProblem[] = [];
  for (const doc of parseAllDocuments(content)) {
    if (!('errors' in doc) || doc.errors.length) continue;
    let obj: unknown;
    try {
      obj = doc.toJS();
    } catch {
      continue;
    }
    if (!isObj(obj) || !('apiVersion' in obj || 'kind' in obj)) continue;
    const kind = typeof obj.kind === 'string' && obj.kind ? obj.kind : '';
    const meta = isObj(obj.metadata) ? obj.metadata : undefined;
    const name = typeof meta?.name === 'string' ? meta.name : '';
    const where = kind ? `${kind}${name ? ` "${name}"` : ''}` : `Object (apiVersion ${String(obj.apiVersion ?? '?')}${name ? `, name "${name}"` : ''})`;
    // Every object needs both, which kubectl and kustomize enforce ("missing kind in object {{apps/v1 } …}").
    // Kustomize's own config files (Kustomization, Component) have no metadata.
    if (!kind) problems.push({ missing: 'kind', message: `${where}: kind: Required value (kustomize: "missing kind in object")` });
    if (!name && typeof meta?.generateName !== 'string' && !/^kustomize\.config\.k8s\.io\//.test(String(obj.apiVersion ?? ''))) {
      problems.push({ missing: meta ? 'name' : 'metadata', message: `${where}: metadata.name: Required value` });
    }
    if (!POD_SPEC[kind]) continue;
    const path = POD_SPEC[kind];
    const at = path.join('.');
    const spec = path.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), obj);
    if (!isObj(spec)) continue;
    const inits = Array.isArray(spec.initContainers) ? spec.initContainers : [];

    if (!Array.isArray(spec.containers) || !spec.containers.length) {
      // The usual cause: the `containers:` header (and the main container's name/image) was deleted,
      // so the main container's settings now continue the last init container.
      const stray = inits
        .map((c, i) => ({ i, c, fields: isObj(c) ? MAIN_CONTAINER_FIELDS.filter((f) => f in c) : [] }))
        .filter((s) => s.fields.length)
        .at(-1);
      problems.push({
        missing: 'containers',
        message:
          `${where}: ${at}.containers: Required value — the pod has no main container` +
          (stray
            ? `; the main container's settings (${stray.fields.join(', ')}) are nested under ${at}.initContainers[${stray.i}]` +
              `${isObj(stray.c) && typeof stray.c.name === 'string' ? ` "${stray.c.name}"` : ''}, ` +
              'so the `containers:` line and the main container\'s `- name:`/`image:` lines are probably missing above them'
            : ''),
      });
    }
    const check = (list: unknown[], field: string, init: boolean) =>
      list.forEach((c, i) => {
        if (!isObj(c)) return;
        for (const key of ['name', 'image']) {
          if (typeof c[key] !== 'string' || !c[key]) {
            problems.push({ missing: key, message: `${where}: ${at}.${field}[${i}].${key}: Required value` });
          }
        }
        if (init && c.restartPolicy !== 'Always') {
          for (const probe of PROBES.filter((p) => p in c)) {
            problems.push({
              message: `${where}: ${at}.${field}[${i}].${probe}: Forbidden: may not be set for init containers without restartPolicy=Always`,
            });
          }
        }
      });
    if (Array.isArray(spec.containers)) check(spec.containers, 'containers', false);
    check(inits, 'initContainers', true);
  }
  return problems.slice(0, 10);
}

/** Keys an error message says are required: `spec.template.spec.containers: Required value` → `containers`. */
export function requiredKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const m of text.matchAll(/([A-Za-z_][\w.[\]-]*?)\s*:\s*Required value/g)) {
    const key = m[1].replace(/\[\d+\]/g, '').split('.').pop();
    if (key && /^[A-Za-z_][\w-]*$/.test(key)) keys.add(key);
  }
  // kustomize: `missing kind in object`; reporters: `no "kind" field`.
  for (const m of text.matchAll(/\bmissing ["'`]?([A-Za-z_][\w-]*)["'`]? in object|\bno ["'`]([A-Za-z_][\w-]*)["'`] field/gi)) keys.add(m[1] ?? m[2]);
  return [...keys];
}
