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
            val pertestDir = providers.gradleProperty("coverage.insights.pertest.dir").orNull
            val jsonDir    = providers.gradleProperty("coverage.insights.jsonDir").orNull
            if (pertestDir != null) {
                val listenerJar = providers.gradleProperty("coverage.insights.listener.jar").orNull
                if (listenerJar != null) {
                    classpath += files(listenerJar)
                }
                systemProperty("coverage.insights.pertest.dir", pertestDir)
            } else if (jsonDir != null) {
                val classesFiles = project.the<SourceSetContainer>()["main"].output.classesDirs
                val srcDirsSet   = project.the<SourceSetContainer>()["main"].allSource.srcDirs
                val jacocoConfig = project.configurations.getByName("jacocoAnt")
                doLast { writeJsonCoverage(jsonDir, extensions, classesFiles, srcDirsSet, jacocoConfig) }
            } else {
                finalizedBy("jacocoTestReport")
            }
        }
        val pertestDir = providers.gradleProperty("coverage.insights.pertest.dir").orNull
        if (pertestDir != null) {
            tasks.register("coverageInsightsBatchReport") {
                doLast {
                    batchConvert(
                        pertestDir,
                        project.the<SourceSetContainer>()["main"].output.classesDirs,
                        project.the<SourceSetContainer>()["main"].allSource.srcDirs,
                        project.configurations.getByName("jacocoAnt")
                    )
                }
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
}

fun batchConvert(
    pertestDir: String,
    classesFiles: org.gradle.api.file.FileCollection,
    srcDirsSet: Set<java.io.File>,
    jacocoConfig: org.gradle.api.artifacts.Configuration
) {
    val execFiles = java.io.File(pertestDir).listFiles { f -> f.extension == "exec" && f.length() > 0 }
        ?: return
    if (execFiles.isEmpty()) return
    val classesDirs = classesFiles.files.filter { it.exists() }
    val srcDirs     = srcDirsSet.filter { it.exists() }
    val jacocoJars  = try { jacocoConfig.resolve() } catch (e: Exception) { return }
    val cl = java.net.URLClassLoader(jacocoJars.map { it.toURI().toURL() }.toTypedArray(), null)
    try {
        val loaderCls   = cl.loadClass("org.jacoco.core.tools.ExecFileLoader")
        val builderCls  = cl.loadClass("org.jacoco.core.analysis.CoverageBuilder")
        val analyzerCls = cl.loadClass("org.jacoco.core.analysis.Analyzer")
        val iLineCls    = cl.loadClass("org.jacoco.core.analysis.ILine")
        val iClassCls   = cl.loadClass("org.jacoco.core.analysis.IClassCoverage")
        val iSourceCls  = cl.loadClass("org.jacoco.core.analysis.ISourceNode")
        val mGetStatus  = iLineCls.getMethod("getStatus")
        val mPkg        = iClassCls.getMethod("getPackageName")
        val mSrc        = iClassCls.getMethod("getSourceFileName")
        val mFirst      = iSourceCls.getMethod("getFirstLine")
        val mLast       = iSourceCls.getMethod("getLastLine")
        val mLine       = iSourceCls.getMethod("getLine", Int::class.java)

        val outer = StringBuilder("{")
        var firstTest = true
        for (execFile in execFiles.sortedBy { it.name }) {
            val testName = execFile.nameWithoutExtension
            val loader   = loaderCls.getDeclaredConstructor().newInstance()
            loaderCls.getMethod("load", java.io.File::class.java).invoke(loader, execFile)
            val execStore = loaderCls.getMethod("getExecutionDataStore").invoke(loader)
            val builder   = builderCls.getDeclaredConstructor().newInstance()
            val analyzer  = analyzerCls.getConstructor(
                cl.loadClass("org.jacoco.core.data.ExecutionDataStore"),
                cl.loadClass("org.jacoco.core.analysis.ICoverageVisitor")
            ).newInstance(execStore, builder)
            for (dir in classesDirs) analyzerCls.getMethod("analyzeAll", java.io.File::class.java).invoke(analyzer, dir)
            @Suppress("UNCHECKED_CAST")
            val classes = builderCls.getMethod("getClasses").invoke(builder) as Collection<Any>

            val linesByFile = mutableMapOf<String, MutableSet<Int>>()
            for (cls in classes) {
                val pkg   = (mPkg.invoke(cls) as? String ?: "").replace('/', java.io.File.separatorChar)
                val src   = mSrc.invoke(cls) as? String ?: continue
                val first = mFirst.invoke(cls) as Int
                val last  = mLast.invoke(cls) as Int
                if (first < 0) continue
                val absPath = srcDirs.map { java.io.File(it, "$pkg\${java.io.File.separator}$src") }
                    .firstOrNull { it.exists() }?.canonicalPath ?: continue
                val set = linesByFile.getOrPut(absPath) { mutableSetOf() }
                for (nr in first..last) {
                    val status = mGetStatus.invoke(mLine.invoke(cls, nr)) as Int
                    if (status >= 2) set.add(nr)
                }
            }

            if (linesByFile.isNotEmpty()) {
                if (!firstTest) outer.append(',')
                firstTest = false
                val escapedName = testName.replace("\\\\", "\\\\\\\\").replace(""""""", """\\"""""")
                outer.append('"').append(escapedName).append('"').append(':').append('{')
                linesByFile.entries.forEachIndexed { i, (p, lines) ->
                    val escaped = p.replace("\\\\", "\\\\\\\\").replace(""""""", """\\"""""")
                    if (i > 0) outer.append(',')
                    outer.append('"').append(escaped).append('"').append(':')
                        .append(lines.sorted().joinToString(",", "[", "]"))
                }
                outer.append('}')
            }
            execFile.delete()
        }
        outer.append("}")
        java.io.File(pertestDir).resolve("coverage-final.json").writeText(outer.toString())
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
        val pertestDir = providers.gradleProperty("coverage.insights.pertest.dir").orNull
        val jsonDir    = providers.gradleProperty("coverage.insights.jsonDir").orNull
        if (pertestDir != null) {
            val listenerJar = providers.gradleProperty("coverage.insights.listener.jar").orNull
            if (listenerJar != null) {
                testTask.classpath += files(listenerJar)
            }
            testTask.systemProperty("coverage.insights.pertest.dir", pertestDir)
        } else if (jsonDir != null) {
            val classesFiles = the<SourceSetContainer>()["main"].output.classesDirs
            val srcDirsSet   = the<SourceSetContainer>()["main"].allSource.srcDirs
            val jacocoConfig = configurations.getByName("jacocoAnt")
            testTask.doLast { writeJsonCoverage(jsonDir, extensions, classesFiles, srcDirsSet, jacocoConfig) }
        } else {
            testTask.finalizedBy(reportTask)
        }
        if (pertestDir != null) {
            tasks.register("coverageInsightsBatchReport") {
                doLast {
                    batchConvert(
                        pertestDir,
                        the<SourceSetContainer>()["main"].output.classesDirs,
                        the<SourceSetContainer>()["main"].allSource.srcDirs,
                        configurations.getByName("jacocoAnt")
                    )
                }
            }
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
