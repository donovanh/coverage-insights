import fs from 'fs';
import path from 'path';

const REDIRECT_BLOCK = `
allprojects {
    plugins.withId("jacoco") {
        tasks.withType<JacocoReport> {
            val baseDir = providers.gradleProperty("coverage.insights.xmlDir").orNull
            if (baseDir != null) {
                reports {
                    xml.required.set(true)
                    xml.outputLocation.set(file("\$baseDir/\${project.path.trimStart(':').replace(':', '/')}/jacoco.xml"))
                }
            }
        }
        tasks.withType<Test> {
            finalizedBy("jacocoTestReport")
        }
    }
}`;

const INJECTION_BLOCK = `
allprojects {
    pluginManager.withPlugin("java") {
        apply(plugin = "jacoco")
        val testTask = tasks.findByName("test") ?: return@withPlugin
        val reportTask = tasks.maybeCreate("jacocoTestReport", JacocoReport::class.java).apply {
            dependsOn(testTask)
            executionData(testTask)
            sourceSets(the<SourceSetContainer>()["main"])
        }
        testTask.finalizedBy(reportTask)
    }
}`;

/** Generate content for the JaCoCo Gradle init script. */
export function generateInitScript(injection: boolean): string {
  return injection ? INJECTION_BLOCK + '\n' + REDIRECT_BLOCK : REDIRECT_BLOCK;
}

/** Return true if any build file in the project mentions jacoco. */
export function detectJacoco(projectRoot: string, modulePaths: string[]): boolean {
  const dirs = [projectRoot, ...modulePaths];
  for (const dir of dirs) {
    for (const name of ['build.gradle.kts', 'build.gradle']) {
      const p = path.join(dir, name);
      try {
        if (fs.existsSync(p) && String(fs.readFileSync(p, 'utf8')).includes('jacoco')) return true;
      } catch { /* ignore */ }
    }
  }
  return false;
}
