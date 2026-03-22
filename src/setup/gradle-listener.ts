import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { findGradleCommand } from '../build/runners/gradle/settings.js';

const CACHE_DIR = path.join(os.homedir(), '.coverage-insights');
const JAR_PATH = path.join(CACHE_DIR, 'listener.jar');
const HASH_PATH = path.join(CACHE_DIR, 'listener.jar.hash');

// Inlined source — TypeScript build does not copy .java files to dist/
const LISTENER_SOURCE = `package com.coverageinsights;

import org.junit.runner.Description;
import org.junit.runner.notification.Failure;
import org.junit.runner.notification.RunListener;
import java.io.File;
import java.lang.reflect.Method;
import java.nio.file.Files;

public class PerTestCoverageListener extends RunListener {

    private final String outputDir =
        System.getProperty("coverage.insights.pertest.dir", "");
    private String currentTestName;

    @Override
    public void testStarted(Description d) {
        currentTestName = safeFileName(d.getClassName() + "." + d.getMethodName());
        resetJacoco();
    }

    @Override
    public void testFinished(Description d) throws Exception {
        if (outputDir.isEmpty()) return;
        dumpExec(outputDir, currentTestName);
    }

    @Override
    public void testFailure(Failure f) {
        // Do not skip — coverage on failing tests is still valid
    }

    @Override
    public void testAssumptionFailure(Failure f) {
        // Assumption failures (e.g. @Ignore via assumeTrue) — skip dump
        currentTestName = null;
    }

    private void resetJacoco() {
        if (outputDir.isEmpty()) return;
        try {
            Object agent = getAgent();
            agent.getClass().getMethod("reset").invoke(agent);
        } catch (Throwable ignored) {}
    }

    private void dumpExec(String dir, String name) {
        if (name == null) return;
        try {
            Object agent = getAgent();
            // getExecutionData(boolean reset) — false: don't auto-reset after dump
            byte[] data = (byte[]) agent.getClass()
                .getMethod("getExecutionData", boolean.class)
                .invoke(agent, false);
            File out = new File(dir, name + ".exec");
            out.getParentFile().mkdirs();
            Files.write(out.toPath(), data);
            currentTestName = null;
        } catch (Throwable ignored) {}
    }

    private Object getAgent() throws Exception {
        Class<?> rt = Class.forName("org.jacoco.agent.rt.RT");
        return rt.getMethod("getAgent").invoke(null);
    }

    private String safeFileName(String name) {
        return name.replaceAll("[^a-zA-Z0-9._-]", "_");
    }
}`;

function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function isCacheValid(hash: string): boolean {
  if (!fs.existsSync(JAR_PATH) || !fs.existsSync(HASH_PATH)) {
    return false;
  }
  const storedHash = String(fs.readFileSync(HASH_PATH, 'utf8')).trim();
  return storedHash === hash;
}

function buildJar(projectRoot: string, javaSource: string, hash: string): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-insights-listener-'));

  try {
    // Write PerTestCoverageListener.java
    const javaDir = path.join(tmpDir, 'src', 'main', 'java', 'com', 'coverageinsights');
    fs.mkdirSync(javaDir, { recursive: true });
    fs.writeFileSync(path.join(javaDir, 'PerTestCoverageListener.java'), javaSource);

    // Write META-INF/services/org.junit.runner.notification.RunListener
    const servicesDir = path.join(tmpDir, 'src', 'main', 'resources', 'META-INF', 'services');
    fs.mkdirSync(servicesDir, { recursive: true });
    fs.writeFileSync(
      path.join(servicesDir, 'org.junit.runner.notification.RunListener'),
      'com.coverageinsights.PerTestCoverageListener'
    );

    // Write build.gradle
    fs.writeFileSync(
      path.join(tmpDir, 'build.gradle'),
      [
        "plugins { id 'java' }",
        "repositories { mavenCentral() }",
        "dependencies {",
        "  compileOnly 'junit:junit:4.13.2'",
        "}",
        "jar {",
        "  archiveFileName = 'listener.jar'",
        "  from sourceSets.main.output",
        "}",
      ].join('\n')
    );

    // Write settings.gradle
    fs.writeFileSync(
      path.join(tmpDir, 'settings.gradle'),
      "rootProject.name = 'coverage-insights-listener'"
    );

    // Run gradle jar
    let gradleCmd = findGradleCommand(projectRoot);
    if (gradleCmd.startsWith('.')) {
      gradleCmd = path.resolve(projectRoot, gradleCmd);
    }
    execFileSync(gradleCmd, ['jar', '--no-daemon'], {
      cwd: tmpDir,
      stdio: 'pipe',
    });

    // Ensure cache directory exists
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    // Copy JAR to cache
    fs.copyFileSync(path.join(tmpDir, 'build', 'libs', 'listener.jar'), JAR_PATH);

    // Write hash
    fs.writeFileSync(HASH_PATH, hash);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function ensureListenerJar(projectRoot: string): string {
  const javaSource = LISTENER_SOURCE;
  const hash = computeHash(javaSource);

  if (isCacheValid(hash)) {
    return JAR_PATH;
  }

  buildJar(projectRoot, javaSource, hash);
  return JAR_PATH;
}
