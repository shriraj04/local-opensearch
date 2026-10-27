// Finding a Java for the one-time OpenSearch build, without sudo: fake Java folders and a fake probe.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findJava, javaProblem, javaHelp } from '../scripts/java.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'los-java-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const home = path.join(root, 'home');
const jvmDir = path.join(root, 'jvm');
fs.mkdirSync(jvmDir, { recursive: true });

const FULL = ['java.base', 'java.logging', 'java.management', 'java.naming', 'java.xml', 'jdk.unsupported', 'jdk.incubator.vector'];
const infos = new Map();
/** A fake Java folder (bin/java) whose probe reports `major` and `modules`. */
function fakeJava(dir, major, modules = FULL) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'java'), '');
  infos.set(fs.realpathSync(dir), { major, modules: new Set(modules) });
  return fs.realpathSync(dir);
}
const probe = (dir) => infos.get(dir) || null;

const testsigma = fakeJava(path.join(home, '.testsigma', 'agent', 'jre'), 21);
const vscode25 = fakeJava(path.join(root, 'vscode-jre-25'), 25);
const trimmed21 = fakeJava(path.join(root, 'trimmed-21'), 21, FULL.filter((m) => m !== 'jdk.incubator.vector'));
fakeJava(path.join(jvmDir, 'java-11-openjdk-amd64'), 11);

test('without sudo: the Testsigma agent Java is found by itself (system Java 11 is too old)', () => {
  assert.deepEqual(findJava({ home, jvmDir, probe }), { home: testsigma, major: 21, javaHomeProblem: null });
});

test('a usable JAVA_HOME comes first; a system Java 17 or 21 before per-user ones', () => {
  const j17 = fakeJava(path.join(root, 'jdk-17'), 17, FULL.filter((m) => m !== 'jdk.incubator.vector'));
  assert.equal(findJava({ javaHome: j17, home, jvmDir, probe }).home, j17, 'Java 17 does not need the vector module');
  const sys21 = fakeJava(path.join(jvmDir, 'java-21-openjdk-amd64'), 21);
  try {
    assert.equal(findJava({ home, jvmDir, probe }).home, sys21);
  } finally {
    fs.rmSync(sys21, { recursive: true });
  }
});

test('JAVA_HOME that cannot run OpenSearch is skipped, with the reason', () => {
  const r = findJava({ javaHome: vscode25, home, jvmDir, probe });
  assert.equal(r.home, testsigma);
  assert.match(r.javaHomeProblem, /Java 25; OpenSearch 2.x needs Java 17 to 21/);
  assert.match(findJava({ javaHome: trimmed21, home, jvmDir, probe }).javaHomeProblem, /without the module\(s\) jdk.incubator.vector/);
  assert.equal(findJava({ javaHome: path.join(root, 'nope'), home, jvmDir, probe }).javaHomeProblem, 'does not exist');
});

test('a symlinked JAVA_HOME works (it is resolved, not refused)', () => {
  const link = path.join(root, 'java-link');
  fs.symlinkSync(testsigma, link);
  assert.equal(findJava({ javaHome: link, home: path.join(root, 'empty-home'), jvmDir, probe }).home, testsigma);
});

test('nothing usable: null, and the help says how to fix it without sudo', () => {
  const r = findJava({ home: path.join(root, 'empty-home'), jvmDir, probe });
  assert.equal(r.home, null);
  const help = javaHelp({ javaHome: vscode25, javaHomeProblem: 'is Java 25; OpenSearch 2.x needs Java 17 to 21' });
  assert.match(help, /JAVA_HOME \(.*vscode-jre-25\) is Java 25/);
  assert.match(help, /No sudo needed: point JAVA_HOME in \.env/);
  assert.match(help, /docker load/);
});

test('javaProblem: version range and modules', () => {
  assert.equal(javaProblem({ major: 17, modules: new Set(FULL) }), null);
  assert.equal(javaProblem({ major: 21, modules: new Set(FULL) }), null);
  assert.match(javaProblem({ major: 11, modules: new Set(FULL) }), /Java 11/);
  assert.match(javaProblem(null), /does not run/);
});
