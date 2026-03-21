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
                    xml.outputLocation.set(file("$baseDir/\${project.path.trimStart(':').replace(':', '/')}/jacoco.xml"))
                }
            }
        }
        tasks.withType<Test> {
            outputs.upToDateWhen { false }
            jvmArgs("-XX:TieredStopAtLevel=1")
            val jsonDir = providers.gradleProperty("coverage.insights.jsonDir").orNull
            if (jsonDir != null) {
                val classesFiles = project.the<SourceSetContainer>()["main"].output.classesDirs
                val srcDirsSet  = project.the<SourceSetContainer>()["main"].allSource.srcDirs
                val jacocoConfig = project.configurations.getByName("jacocoAnt")
                doLast { writeJsonCoverage(jsonDir, extensions, classesFiles, srcDirsSet, jacocoConfig) }
            } else {
                finalizedBy("jacocoTestReport")
            }
        }
    }
}

fun writeJsonCoverage(
    jsonDir: String,
    exts: org.gradle.api.plugins.ExtensionContainer,
    classesFiles: org.gradle.api.file.FileCollection,
    srcDirsSet: Set<java.io.File>,
    jacocoConfig: org.gradle.api.artifacts.Configuration
) {
    val ext      = exts.findByType<JacocoTaskExtension>() ?: return
    val execFile = ext.destinationFile ?: return
    if (!execFile.exists()) return
    val classesDirs = classesFiles.files.filter { it.exists() }
    val srcDirs     = srcDirsSet.filter    { it.exists() }
    val jacocoJars  = try { jacocoConfig.resolve() } catch (e: Exception) { return }
    // null parent: isolate from daemon classpath to avoid version conflicts with JaCoCo already loaded by Gradle
    val cl = java.net.URLClassLoader(jacocoJars.map { it.toURI().toURL() }.toTypedArray(), null)
    try {
        val loaderCls  = cl.loadClass("org.jacoco.core.tools.ExecFileLoader")
        val loader     = loaderCls.getDeclaredConstructor().newInstance()
        loaderCls.getMethod("load", java.io.File::class.java).invoke(loader, execFile)
        val execStore  = loaderCls.getMethod("getExecutionDataStore").invoke(loader)
        val builderCls = cl.loadClass("org.jacoco.core.analysis.CoverageBuilder")
        val builder    = builderCls.getDeclaredConstructor().newInstance()
        val analyzerCls = cl.loadClass("org.jacoco.core.analysis.Analyzer")
        val analyzer    = analyzerCls.getConstructor(
            cl.loadClass("org.jacoco.core.data.ExecutionDataStore"),
            cl.loadClass("org.jacoco.core.analysis.ICoverageVisitor")
        ).newInstance(execStore, builder)
        for (dir in classesDirs) analyzerCls.getMethod("analyzeAll", java.io.File::class.java).invoke(analyzer, dir)
        @Suppress("UNCHECKED_CAST")
        val classes    = builderCls.getMethod("getClasses").invoke(builder) as Collection<Any>
        val iLineCls   = cl.loadClass("org.jacoco.core.analysis.ILine")
        val getStatus  = iLineCls.getMethod("getStatus")
        val iClassCls  = cl.loadClass("org.jacoco.core.analysis.IClassCoverage")
        val iSourceCls = cl.loadClass("org.jacoco.core.analysis.ISourceNode")
        val mPkg    = iClassCls.getMethod("getPackageName")
        val mSrc    = iClassCls.getMethod("getSourceFileName")
        val mFirst  = iSourceCls.getMethod("getFirstLine")
        val mLast   = iSourceCls.getMethod("getLastLine")
        val mLine   = iSourceCls.getMethod("getLine", Int::class.java)
        val result     = mutableMapOf<String, MutableSet<Int>>()
        for (cls in classes) {
            val pkg   = (mPkg.invoke(cls) as? String ?: "").replace('/', java.io.File.separatorChar)
            val src   = mSrc.invoke(cls) as? String ?: continue
            val first = mFirst.invoke(cls) as Int
            val last  = mLast.invoke(cls) as Int
            if (first < 0) continue
            val absPath = srcDirs.map { java.io.File(it, "$pkg\${java.io.File.separator}$src") }
                .firstOrNull { it.exists() }?.canonicalPath ?: continue
            val lineList = result.getOrPut(absPath) { mutableSetOf() }
            for (nr in first..last) {
                val status = getStatus.invoke(mLine.invoke(cls, nr)) as Int
                if (status >= 2) lineList.add(nr)
            }
        }
        val sb = StringBuilder("{")
        result.entries.forEachIndexed { i, (p, lines) ->
            val sorted = lines.sorted()
            if (i > 0) sb.append(',')
            val escaped = p.replace("\\\\", "\\\\\\\\").replace(""""""", """\\"""""")
            sb.append('"').append(escaped).append('"').append(':')
               .append(sorted.joinToString(",", "[", "]"))
        }
        sb.append("}")
        java.io.File(jsonDir).also { it.mkdirs() }.resolve("coverage-final.json").writeText(sb.toString())
    } finally { cl.close() }
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
        testTask.outputs.upToDateWhen { false }
        testTask.jvmArgs("-XX:TieredStopAtLevel=1")
        val jsonDir = providers.gradleProperty("coverage.insights.jsonDir").orNull
        if (jsonDir != null) {
            val classesFiles = the<SourceSetContainer>()["main"].output.classesDirs
            val srcDirsSet   = the<SourceSetContainer>()["main"].allSource.srcDirs
            val jacocoConfig = configurations.getByName("jacocoAnt")
            testTask.doLast { writeJsonCoverage(jsonDir, extensions, classesFiles, srcDirsSet, jacocoConfig) }
        } else {
            testTask.finalizedBy(reportTask)
        }
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
