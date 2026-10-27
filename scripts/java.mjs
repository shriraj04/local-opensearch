// Finds a Java that can run the OpenSearch build: Java 17 to 21, with the modules OpenSearch loads.
// It also looks where people without sudo already have one: the Testsigma agent ships Java 21.
// A Java is used only the first time, to build the image (it is copied into opensearch/build/jdk).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const JAVA_MIN = 17;
export const JAVA_MAX = 21; // OpenSearch 2.x does not start on newer Java
// What OpenSearch's launcher and server load. jvm.options adds jdk.incubator.vector from Java 20 on;
// trimmed runtimes (e.g. the one bundled with VS Code's Java extension) leave it out.
const BASE_MODULES = ['java.base', 'java.logging', 'java.management', 'java.naming', 'java.xml', 'jdk.unsupported'];
export const requiredModules = (major) => (major >= 20 ? [...BASE_MODULES, 'jdk.incubator.vector'] : BASE_MODULES);

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir).map((d) => path.join(dir, d));
  } catch {
    return [];
  }
};

/** Folders that may hold a Java, best first: JAVA_HOME, the system ones (21, then 17), then per-user ones. */
export function javaCandidates({ javaHome, home = os.homedir(), jvmDir = '/usr/lib/jvm' } = {}) {
  const jvm = listDir(jvmDir);
  const byVersion = (v) => jvm.filter((d) => new RegExp(`(^|[-.])${v}([-.]|$)`).test(path.basename(d)));
  const testsigma = [
    path.join(home, '.testsigma', 'agent', 'jre'),
    ...['', 'Documents', 'Downloads', 'Desktop'].map((d) => path.join(home, d, 'TestsigmaAgent-Linux', 'TestsigmaAgent', 'jre')),
  ];
  const userJdks = [...listDir(path.join(home, '.sdkman', 'candidates', 'java')), ...listDir(path.join(home, '.jdks'))];
  return [javaHome, ...byVersion(21), ...byVersion(17), ...jvm, ...testsigma, ...userJdks].filter(Boolean);
}

/** { major, modules } of the Java in `dir`, from `java --list-modules`; null when it does not run. */
export function probeJava(dir) {
  const r = spawnSync(path.join(dir, 'bin', 'java'), ['--list-modules'], { encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) return null;
  const modules = new Map(r.stdout.split('\n').map((l) => l.trim().split('@')).filter(([m]) => m));
  const major = parseInt(modules.get('java.base'), 10);
  return Number.isFinite(major) ? { major, modules: new Set(modules.keys()) } : null;
}

/** Why the Java described by `info` cannot run OpenSearch, or null when it can. */
export function javaProblem(info) {
  if (!info) return 'does not run (or is older than Java 9)';
  if (info.major < JAVA_MIN || info.major > JAVA_MAX) return `is Java ${info.major}; OpenSearch 2.x needs Java ${JAVA_MIN} to ${JAVA_MAX}`;
  const missing = requiredModules(info.major).filter((m) => !info.modules.has(m));
  return missing.length ? `is Java ${info.major} without the module(s) ${missing.join(', ')} that OpenSearch needs` : null;
}

/**
 * The first Java that can run OpenSearch: { home, major }, or { home: null }. `javaHomeProblem` says why
 * an explicitly set JAVA_HOME was not used (other folders are skipped quietly).
 */
export function findJava({ javaHome, home, jvmDir, probe = probeJava } = {}) {
  const seen = new Set();
  let javaHomeProblem = null;
  for (const dir of javaCandidates({ javaHome, home, jvmDir })) {
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      if (dir === javaHome) javaHomeProblem = 'does not exist';
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    if (!fs.existsSync(path.join(real, 'bin', 'java'))) {
      if (dir === javaHome) javaHomeProblem = 'has no bin/java';
      continue;
    }
    const info = probe(real);
    const problem = javaProblem(info);
    if (!problem) return { home: real, major: info.major, javaHomeProblem };
    if (dir === javaHome) javaHomeProblem = problem;
  }
  return { home: null, major: null, javaHomeProblem };
}

/** What to do when no usable Java is found, in plain words. */
export function javaHelp({ javaHome, javaHomeProblem } = {}) {
  const lines = [];
  if (javaHome && javaHomeProblem) lines.push(`JAVA_HOME (${javaHome}) ${javaHomeProblem}.`);
  lines.push(
    `No Java ${JAVA_MIN} to ${JAVA_MAX} found on this computer. It is only needed once, to build the OpenSearch image. Any of these works:`,
    `  - No sudo needed: point JAVA_HOME in .env at a Java ${JAVA_MIN} to ${JAVA_MAX} that is already on this laptop, e.g.  echo "JAVA_HOME=/path/to/jre" >> .env  (the Testsigma agent's ~/.testsigma/agent/jre is found by itself)`,
    '  - With sudo: sudo apt install openjdk-17-jre-headless',
    '  - Or get the ready-made image file from Shriraj and run: docker load -i astra-opensearch-image.tar.gz (SETUP.md, "If Java will not install")',
  );
  return lines.join('\n');
}
