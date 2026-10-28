/** `bun run dev`: hub, worker and ops with --watch, output prefixed per process. */
const procs = [
  { name: "hub", color: "\x1b[35m", file: "src/hub/index.tsx" },
  { name: "worker", color: "\x1b[36m", file: "src/hub/worker.ts" },
  { name: "ops", color: "\x1b[33m", file: "src/ops/index.tsx" },
];
const only = process.argv.slice(2);
const children = procs
  .filter((p) => only.length === 0 || only.includes(p.name))
  .map((p) => {
    const child = Bun.spawn(["bun", "--watch", "run", p.file], { stdout: "pipe", stderr: "pipe", env: process.env });
    const prefix = `${p.color}[${p.name}]\x1b[0m `;
    for (const stream of [child.stdout, child.stderr]) {
      (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of stream) {
          buffer += decoder.decode(chunk);
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) console.log(prefix + line);
        }
      })();
    }
    return child;
  });

const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.all(children.map((c) => c.exited));

export {};
