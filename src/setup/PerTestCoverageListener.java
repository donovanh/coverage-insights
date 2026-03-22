package com.coverageinsights;

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
}
