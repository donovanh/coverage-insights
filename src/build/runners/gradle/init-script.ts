import fs from 'fs';
import path from 'path';

// Top-level helper functions included in all generated init scripts.
// Defined at script scope so they are callable from within allprojects { } blocks.
const HELPERS = `
/** Collect JaCoCo + ASM jars from the buildscript classpath for URLClassLoader use. */
fun resolveJacocoJars(proj: Project): List<java.io.File> =
    proj.buildscript.configurations.asMap.values
        .flatMap { cfg -> try { cfg.resolvedConfiguration.resolvedArtifacts } catch (e: Exception) { emptySet() } }
        .filter { it.moduleVersion.id.group == "org.jacoco" || it.moduleVersion.id.group == "org.ow2.asm" }
        .map { it.file }
        .distinct()

/**
 * Convert per-test .exec files in pertestDir into per-test .json files.
 * Each JSON file maps absolute source path to a sorted list of covered line numbers.
 * Files are processed in parallel using a fixed thread pool.
 *
 * If .ci-filter.txt exists in pertestDir, only exec files listed there are processed;
 * all other exec files are deleted.
 */
fun batchConvert(
    pertestDir: String,
    classesFiles: org.gradle.api.file.FileCollection,
    srcDirsSet: Set<java.io.File>,
    project: Project
) {
    val allExecFiles = java.io.File(pertestDir).listFiles { f -> f.extension == "exec" }?.toList() ?: return
    if (allExecFiles.isEmpty()) return

    val filterFile = java.io.File(pertestDir, ".ci-filter.txt")
    val testFilter: Set<String>? = if (filterFile.exists()) {
        try { filterFile.readText().trim().split("\\n").filter { it.isNotEmpty() }.toSet() } catch (e: Exception) { null }
    } else null
    val execFiles = if (testFilter != null && testFilter.isNotEmpty()) {
        allExecFiles.filter { it.nameWithoutExtension in testFilter }
    } else {
        allExecFiles.toList()
    }
    if (execFiles.isEmpty()) { allExecFiles.forEach { it.delete() }; return }
    if (testFilter != null) { allExecFiles.forEach { if (it.nameWithoutExtension !in testFilter) it.delete() } }

    val jacocoJars = resolveJacocoJars(project)
    val cl = try {
        java.net.URLClassLoader(jacocoJars.map { it.toURI().toURL() }.toTypedArray(), null)
    } catch (e: Exception) {
        System.err.println("coverage-insights: batchConvert classloader failed — \${e.message}")
        return
    }

    try {
        val execDataStoreCls    = cl.loadClass("org.jacoco.core.data.ExecutionDataStore")
        val execFileLoaderCls   = cl.loadClass("org.jacoco.core.tools.ExecFileLoader")
        val coverageBuilderCls  = cl.loadClass("org.jacoco.core.analysis.CoverageBuilder")
        val analyzerCls         = cl.loadClass("org.jacoco.core.analysis.Analyzer")
        val ibundleCls          = cl.loadClass("org.jacoco.core.analysis.IBundleCoverage")
        val iclassCls           = cl.loadClass("org.jacoco.core.analysis.IClassCoverage")
        val ilineCls            = cl.loadClass("org.jacoco.core.analysis.ILine")
        val iCovVisitorCls      = cl.loadClass("org.jacoco.core.analysis.ICoverageVisitor")
        val iPackageCls         = try { cl.loadClass("org.jacoco.core.analysis.IPackageCoverage") } catch (e: Exception) { null }
        val mGetExecStore       = execFileLoaderCls.getMethod("getExecutionDataStore")
        val mLoad               = execFileLoaderCls.getMethod("load", java.io.File::class.java)
        val mGetBundle          = coverageBuilderCls.getMethod("getBundle", String::class.java)
        val mGetPackages        = ibundleCls.getMethod("getPackages")
        val mGetClasses         = iPackageCls?.getMethod("getClasses")
        val mGetSrcFile         = iclassCls.getMethod("getSourceFileName")
        val mGetPkgName         = iclassCls.getMethod("getPackageName")
        val mGetFirstLine       = iclassCls.getMethod("getFirstLine")
        val mGetLastLine        = iclassCls.getMethod("getLastLine")
        val mGetLine            = iclassCls.getMethod("getLine", Int::class.java)
        val mGetStatus          = ilineCls.getMethod("getStatus")
        val mAnalyzeAll         = analyzerCls.getMethod("analyzeAll", java.io.File::class.java)
        val analyzerCtor        = analyzerCls.getConstructor(execDataStoreCls, iCovVisitorCls)

        // allSource.srcDirs may be empty at init-script configuration time.
        // Re-resolve at execution time (when afterSuite calls batchConvert).
        val resolvedSrcDirs = srcDirsSet.filter { it.exists() }.let {
            if (it.isNotEmpty()) it
            else try {
                project.the<SourceSetContainer>()["main"].allSource.srcDirs.filter { d -> d.exists() }
            } catch (e: Exception) { it }
        }

        val threads = minOf(Runtime.getRuntime().availableProcessors(), 8)
        val pool = java.util.concurrent.Executors.newFixedThreadPool(threads)
        try {
            val futures = execFiles.sortedBy { it.name }.map { execFile ->
                pool.submit(java.util.concurrent.Callable {
                    try {
                        val loader  = execFileLoaderCls.getDeclaredConstructor().newInstance()
                        mLoad.invoke(loader, execFile)
                        val store   = mGetExecStore.invoke(loader)
                        val builder = coverageBuilderCls.getDeclaredConstructor().newInstance()
                        val analyzer = analyzerCtor.newInstance(store, builder)
                        for (classDir in classesFiles.files) {
                            if (classDir.exists()) try { mAnalyzeAll.invoke(analyzer, classDir) } catch (e: Exception) {}
                        }
                        val bundle = mGetBundle.invoke(builder, "coverage")
                        val linesByFile = mutableMapOf<String, MutableSet<Int>>()
                        @Suppress("UNCHECKED_CAST")
                        for (pkg in (mGetPackages.invoke(bundle) as Collection<Any>)) {
                            @Suppress("UNCHECKED_CAST")
                            for (cls in (mGetClasses?.invoke(pkg) as? Collection<Any> ?: emptyList<Any>())) {
                                val srcFile = mGetSrcFile.invoke(cls) as? String ?: continue
                                val pkgName = mGetPkgName.invoke(cls) as? String ?: continue
                                val first   = mGetFirstLine.invoke(cls) as Int
                                val last    = mGetLastLine.invoke(cls)  as Int
                                if (first < 0 || last < 0) continue
                                var absPath: String? = null
                                for (srcDir in resolvedSrcDirs) {
                                    val candidate = java.io.File(srcDir, "\$pkgName/\$srcFile")
                                    if (candidate.exists()) { absPath = candidate.absolutePath; break }
                                }
                                if (absPath == null) absPath = "\$pkgName/\$srcFile"
                                val coveredLines = mutableSetOf<Int>()
                                for (nr in first..last) {
                                    val status = mGetStatus.invoke(mGetLine.invoke(cls, nr)) as Int
                                    if (status >= 2) coveredLines.add(nr)
                                }
                                if (coveredLines.isNotEmpty()) linesByFile.getOrPut(absPath) { mutableSetOf() }.addAll(coveredLines)
                            }
                        }
                        if (linesByFile.isNotEmpty()) {
                            val outFile = java.io.File(pertestDir, "\${execFile.nameWithoutExtension}.json")
                            java.io.BufferedWriter(java.io.FileWriter(outFile)).use { w ->
                                w.write("{")
                                linesByFile.entries.forEachIndexed { i, (p, lines) ->
                                    // Escape path for JSON (backslash and double-quote)
                                    val sb = StringBuilder()
                                    for (ch in p) { when (ch) { '\\\\' -> sb.append("\\\\\\\\"); '"' -> { sb.append('\\\\'); sb.append('"') }; else -> sb.append(ch) } }
                                    if (i > 0) w.write(",")
                                    w.write(34); w.write(sb.toString()); w.write(34); w.write(":")
                                    w.write(lines.sorted().joinToString(",", "[", "]"))
                                }
                                w.write("}")
                            }
                        }
                        execFile.delete()
                    } catch (e: Exception) {
                        System.err.println("coverage-insights: batchConvert error for \${execFile.name} — \${e.message}")
                    }
                })
            }
            futures.forEach { it.get() }
        } finally {
            pool.shutdown()
        }
    } catch (e: Exception) {
        System.err.println("coverage-insights: batchConvert failed — \${e.message}")
    } finally {
        try { cl.close() } catch (e: Exception) {}
    }
}
`;

const REDIRECT_BLOCK = `
allprojects {
    plugins.withId("jacoco") {
        tasks.withType<Test> {
            // Skip integration test tasks — only instrument the primary unit test task.
            if (name != "test") return@withType
            outputs.upToDateWhen { false }
            jvmArgs("-XX:TieredStopAtLevel=1")
            val pertestDir = providers.gradleProperty("coverage.insights.pertest.dir").orNull
            val xmlDir     = providers.gradleProperty("coverage.insights.xmlDir").orNull
            if (pertestDir != null) {
                // Batch mode: run as TCP server; dump per-test exec via ExecDumpClient after each test.
                val port = (providers.gradleProperty("coverage.insights.pertest.port").orNull ?: "6300").toInt()
                extensions.configure<JacocoTaskExtension> {
                    output = JacocoTaskExtension.Output.TCP_SERVER
                    this.port = port
                }
                val classesFiles = project.the<SourceSetContainer>()["main"].output.classesDirs
                val srcDirsSet   = project.the<SourceSetContainer>()["main"].allSource.srcDirs
                val jacocoJars   = resolveJacocoJars(project)
                addTestListener(object : TestListener {
                    var cl: java.net.URLClassLoader? = null
                    override fun beforeSuite(suite: TestDescriptor) {
                        if (suite.parent != null) return
                        try {
                            cl = java.net.URLClassLoader(jacocoJars.map { it.toURI().toURL() }.toTypedArray(), null)
                        } catch (e: Exception) {
                            System.err.println("coverage-insights: URLClassLoader init failed — \${e.message}")
                        }
                    }
                    override fun beforeTest(d: TestDescriptor) {}
                    override fun afterTest(d: TestDescriptor, r: TestResult) {
                        val loader = cl ?: return
                        var lastEx: Exception? = null
                        for (attempt in 0..2) {
                            try {
                                if (attempt > 0) Thread.sleep(100L * attempt)
                                val cCls = loader.loadClass("org.jacoco.core.tools.ExecDumpClient")
                                val c    = cCls.getDeclaredConstructor().newInstance()
                                cCls.getMethod("setReset", Boolean::class.java).invoke(c, true)
                                try { cCls.getMethod("setRetryCount", Int::class.java).invoke(c, 0) } catch (e: Exception) {}
                                val dumped = cCls.getMethod("dump", String::class.java, Int::class.java).invoke(c, "localhost", port)
                                val name   = "\${d.className}.\${d.name}".replace(Regex("[^a-zA-Z0-9._-]"), "_")
                                val lCls   = loader.loadClass("org.jacoco.core.tools.ExecFileLoader")
                                lCls.getMethod("save", java.io.File::class.java, Boolean::class.java)
                                    .invoke(dumped, java.io.File(pertestDir, "\$name.exec"), false)
                                return
                            } catch (e: Exception) { lastEx = e }
                        }
                        val cause = (lastEx as? java.lang.reflect.InvocationTargetException)?.targetException ?: lastEx
                        System.err.println("coverage-insights: dump failed for \${d.className}.\${d.name} — \${cause?.javaClass?.simpleName}: \${cause?.message}")
                    }
                    override fun afterSuite(suite: TestDescriptor, r: TestResult) {
                        if (suite.parent != null) return
                        try { cl?.close() } catch (e: Exception) {}
                        cl = null
                        batchConvert(pertestDir, classesFiles, srcDirsSet, project)
                    }
                })
            } else if (xmlDir != null) {
                // Per-test (runOne) mode: redirect exec file to worker dir, then generate XML via
                // a dedicated task that has no dependency on integration test tasks.
                extensions.configure<JacocoTaskExtension> {
                    destinationFile = file("\$xmlDir/test.exec")
                }
                // Root projects may have JaCoCo applied (e.g. via configureCrossModuleTestCoverage)
                // without a main source set — skip report task creation in that case.
                val mainSourceSet = try { project.the<SourceSetContainer>().findByName("main") } catch (e: Exception) { null }
                if (mainSourceSet != null) {
                    val ciReport = tasks.maybeCreate("coverageInsightsReport", JacocoReport::class.java)
                    ciReport.executionData.setFrom(files("\$xmlDir/test.exec"))
                    ciReport.sourceSets(mainSourceSet)
                    ciReport.reports {
                        xml.required.set(true)
                        xml.outputLocation.set(file("\$xmlDir/\${project.path.trimStart(':').replace(':', '/')}/jacoco.xml"))
                    }
                    finalizedBy(ciReport)
                }
            }
        }
    }
}

`;

const INJECTION_BLOCK = `
allprojects {
    pluginManager.withPlugin("java") {
        if (!pluginManager.hasPlugin("jacoco")) apply(plugin = "jacoco")
        val testTask = tasks.findByName("test") as? Test ?: return@withPlugin
        val pertestDir = providers.gradleProperty("coverage.insights.pertest.dir").orNull
        val xmlDir     = providers.gradleProperty("coverage.insights.xmlDir").orNull
        testTask.outputs.upToDateWhen { false }
        testTask.jvmArgs("-XX:TieredStopAtLevel=1")
        if (pertestDir != null) {
            val port = (providers.gradleProperty("coverage.insights.pertest.port").orNull ?: "6300").toInt()
            testTask.extensions.configure<JacocoTaskExtension> {
                output = JacocoTaskExtension.Output.TCP_SERVER
                this.port = port
            }
            val classesFiles = project.the<SourceSetContainer>()["main"].output.classesDirs
            val srcDirsSet   = project.the<SourceSetContainer>()["main"].allSource.srcDirs
            val jacocoJars   = resolveJacocoJars(project)
            testTask.addTestListener(object : TestListener {
                var cl: java.net.URLClassLoader? = null
                override fun beforeSuite(suite: TestDescriptor) {
                    if (suite.parent != null) return
                    try {
                        cl = java.net.URLClassLoader(jacocoJars.map { it.toURI().toURL() }.toTypedArray(), null)
                    } catch (e: Exception) {
                        System.err.println("coverage-insights: URLClassLoader init failed — \${e.message}")
                    }
                }
                override fun beforeTest(d: TestDescriptor) {}
                override fun afterTest(d: TestDescriptor, r: TestResult) {
                    val loader = cl ?: return
                    var lastEx: Exception? = null
                    for (attempt in 0..2) {
                        try {
                            if (attempt > 0) Thread.sleep(100L * attempt)
                            val cCls = loader.loadClass("org.jacoco.core.tools.ExecDumpClient")
                            val c    = cCls.getDeclaredConstructor().newInstance()
                            cCls.getMethod("setReset", Boolean::class.java).invoke(c, true)
                            try { cCls.getMethod("setRetryCount", Int::class.java).invoke(c, 0) } catch (e: Exception) {}
                            val dumped = cCls.getMethod("dump", String::class.java, Int::class.java).invoke(c, "localhost", port)
                            val name   = "\${d.className}.\${d.name}".replace(Regex("[^a-zA-Z0-9._-]"), "_")
                            val lCls   = loader.loadClass("org.jacoco.core.tools.ExecFileLoader")
                            lCls.getMethod("save", java.io.File::class.java, Boolean::class.java)
                                .invoke(dumped, java.io.File(pertestDir, "\$name.exec"), false)
                            return
                        } catch (e: Exception) { lastEx = e }
                    }
                    val cause = (lastEx as? java.lang.reflect.InvocationTargetException)?.targetException ?: lastEx
                    System.err.println("coverage-insights: dump failed for \${d.className}.\${d.name} — \${cause?.javaClass?.simpleName}: \${cause?.message}")
                }
                override fun afterSuite(suite: TestDescriptor, r: TestResult) {
                    if (suite.parent != null) return
                    try { cl?.close() } catch (e: Exception) {}
                    cl = null
                    batchConvert(pertestDir, classesFiles, srcDirsSet, project)
                }
            })
        } else if (xmlDir != null) {
            // Per-test (runOne) mode: use a dedicated task that has no dependency on
            // integration test tasks, so jacocoTestReport's iTest chain is bypassed.
            testTask.extensions.configure<JacocoTaskExtension> {
                destinationFile = file("\$xmlDir/test.exec")
            }
            // Root projects may not have a main source set — skip report task if absent.
            val mainSourceSet = try { the<SourceSetContainer>().findByName("main") } catch (e: Exception) { null }
            if (mainSourceSet != null) {
                val reportTask = tasks.maybeCreate("coverageInsightsReport", JacocoReport::class.java).apply {
                    sourceSets(mainSourceSet)
                    executionData.setFrom(files("\$xmlDir/test.exec"))
                    reports {
                        xml.required.set(true)
                        xml.outputLocation.set(file("\$xmlDir/\${project.path.trimStart(':').replace(':', '/')}/jacoco.xml"))
                    }
                }
                testTask.finalizedBy(reportTask)
            }
        }
    }
}`;

/** Generate content for the JaCoCo Gradle init script. */
export function generateInitScript(injection: boolean): string {
  return HELPERS + (injection ? INJECTION_BLOCK + '\n' + REDIRECT_BLOCK : REDIRECT_BLOCK);
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
