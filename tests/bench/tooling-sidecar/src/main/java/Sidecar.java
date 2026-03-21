import org.gradle.tooling.BuildLauncher;
import org.gradle.tooling.GradleConnector;
import org.gradle.tooling.ProjectConnection;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Persistent Gradle Tooling API sidecar.
 *
 * Note: the Tooling API's BuildLauncher.withArguments() does NOT support
 * CLI-only options like --tests or --daemon.  Test filtering is done via
 * project properties read by the init script, and the daemon is managed
 * implicitly by the ProjectConnection.
 *
 * Protocol (stdin/stdout, JSON lines):
 *   Request:  {"testClass":"com.example.Foo","testMethod":"myTest","workerDir":"/tmp/...","cacheDir":"/tmp/...","initScript":"/tmp/..."}
 *   Response: {"ok":true,"ms":1234}  or  {"ok":false,"ms":1234,"error":"..."}
 *   Special:  send "quit" to stop.
 *
 * Usage: java -jar sidecar.jar <projectDir>
 */
public class Sidecar {

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("Usage: Sidecar <projectDir>");
            System.exit(1);
        }
        File projectDir = new File(args[0]);

        GradleConnector connector = GradleConnector.newConnector()
                .forProjectDirectory(projectDir);

        try (ProjectConnection connection = connector.connect()) {
            System.out.println("ready");
            System.out.flush();

            BufferedReader stdin = new BufferedReader(new InputStreamReader(System.in));
            String line;
            while ((line = stdin.readLine()) != null) {
                if (line.equals("quit")) break;

                String testClass  = extract(line, "testClass");
                String testMethod = extract(line, "testMethod");
                String module     = extract(line, "module");
                String workerDir  = extract(line, "workerDir");
                String cacheDir   = extract(line, "cacheDir");
                String initScript = extract(line, "initScript");

                // Only args supported by BuildLauncher.withArguments() are used here.
                // --tests and --daemon are CLI-only and NOT supported via the Tooling API.
                // Test filtering is handled via project properties read by the init script.
                List<String> buildArgs = new ArrayList<>();
                buildArgs.add("--rerun-tasks");
                buildArgs.add("--no-build-cache");
                if (!cacheDir.isEmpty())   buildArgs.add("--project-cache-dir=" + cacheDir);
                if (!initScript.isEmpty()) { buildArgs.add("--init-script"); buildArgs.add(initScript); }
                buildArgs.add("-Pcoverage.insights.xmlDir=" + workerDir);
                buildArgs.add("-Pcoverage.insights.testClass=" + testClass);
                buildArgs.add("-Pcoverage.insights.testMethod=" + testMethod);

                String taskPath = (module.isEmpty() ? "" : module) + ":test";

                long start = System.nanoTime();
                boolean ok = true;
                String error = "";
                try {
                    connection.newBuild()
                            .forTasks(taskPath)
                            .withArguments(buildArgs.toArray(new String[0]))
                            .setStandardOutput(OutputStream.nullOutputStream())
                            .setStandardError(OutputStream.nullOutputStream())
                            .run();
                } catch (Exception e) {
                    ok = false;
                    error = e.getClass().getSimpleName() + ": " + e.getMessage();
                }
                long ms = (System.nanoTime() - start) / 1_000_000L;
                if (ok) {
                    System.out.println("{\"ok\":true,\"ms\":" + ms + "}");
                } else {
                    System.out.println("{\"ok\":false,\"ms\":" + ms + ",\"error\":\"" + error.replace("\"", "'").replace("\n", " ").substring(0, Math.min(error.length(), 200)) + "\"}");
                }
                System.out.flush();
            }
        }
    }

    private static String extract(String json, String key) {
        Pattern p = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*\"([^\"]*)\"");
        Matcher m = p.matcher(json);
        return m.find() ? m.group(1) : "";
    }
}
