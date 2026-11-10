/**
 * Playbook and inventory paths are relative to ANSIBLE_PROJECT_DIR and must stay inside it, after
 * symlinks are resolved. Checked when a template is saved and again right before every run (the
 * checkout may have changed with `git pull`).
 */
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export type PathKind = "playbook" | "inventory";

export type PathCheck = { ok: true; rel: string; real: string } | { ok: false; error: string };

export function checkProjectPath(projectDir: string, input: string, kind: PathKind): PathCheck {
  const rel = input.trim();
  const label = kind === "playbook" ? "Playbook" : "Inventory";
  if (!rel) return { ok: false, error: `${label}: Pfad fehlt.` };
  if (rel.length > 500) return { ok: false, error: `${label}: Pfad ist zu lang.` };
  if (/[\u0000-\u001f\u007f]/.test(rel)) return { ok: false, error: `${label}: Steuerzeichen sind nicht erlaubt.` };
  if (isAbsolute(rel) || rel.startsWith("~")) return { ok: false, error: `${label}: Bitte einen Pfad relativ zum Projektverzeichnis angeben.` };
  const segments = rel.split(/[\\/]+/);
  if (segments.some((s) => s === "..")) return { ok: false, error: `${label}: „..“ ist nicht erlaubt.` };
  if (segments.some((s) => s.startsWith("-"))) return { ok: false, error: `${label}: Pfadteile dürfen nicht mit „-“ beginnen.` };

  let root: string;
  try {
    root = realpathSync(projectDir);
  } catch {
    return { ok: false, error: "Das Ansible-Projektverzeichnis existiert nicht." };
  }
  let real: string;
  try {
    real = realpathSync(join(root, rel));
  } catch {
    return { ok: false, error: `${label}: „${rel}“ gibt es im Projekt nicht.` };
  }
  const inside = relative(root, real);
  if (inside === "" || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) {
    return { ok: false, error: `${label}: „${rel}“ zeigt aus dem Projektverzeichnis hinaus.` };
  }
  const st = statSync(real);
  if (kind === "playbook") {
    if (!st.isFile()) return { ok: false, error: `${label}: „${rel}“ ist keine Datei.` };
    if (!/\.ya?ml$/i.test(real)) return { ok: false, error: `${label}: Erwartet wird eine .yml- oder .yaml-Datei.` };
  } else if (!st.isFile() && !st.isDirectory()) {
    return { ok: false, error: `${label}: „${rel}“ ist weder Datei noch Verzeichnis.` };
  }
  return { ok: true, rel: segments.filter((s) => s !== "" && s !== ".").join("/"), real };
}

const SKIP_DIRS = new Set([".git", "roles", "group_vars", "host_vars", "collections", "files", "templates", "vars", "defaults", "tasks", "handlers", "library", "filter_plugins", "node_modules"]);

/**
 * Suggestions for the template form: YAML files near the top of the project (playbook candidates)
 * and files / directories whose name mentions "inventor" or "hosts" (inventory candidates).
 */
export function projectSuggestions(projectDir: string): { playbooks: string[]; inventories: string[] } {
  const playbooks: string[] = [];
  const inventories: string[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || playbooks.length + inventories.length > 400) continue;
      const path = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      const inventoryLike = /inventor|^hosts(\.|$)/i.test(name);
      if (st.isDirectory()) {
        if (inventoryLike) inventories.push(rel);
        if (depth < 2 && !SKIP_DIRS.has(name)) walk(path, rel, depth + 1);
      } else if (st.isFile()) {
        if (inventoryLike || /(^|\/)inventor/i.test(prefix)) inventories.push(rel);
        else if (/\.ya?ml$/i.test(name) && !/^(ansible|requirements|galaxy)\b/i.test(name)) playbooks.push(rel);
      }
    }
  };
  walk(projectDir, "", 0);
  return { playbooks, inventories };
}
