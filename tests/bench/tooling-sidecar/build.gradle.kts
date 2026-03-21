plugins {
    java
    id("com.github.johnrengelman.shadow") version "8.1.1"
}

repositories {
    maven { url = uri("https://repo.gradle.org/gradle/libs-releases/") }
    mavenCentral()
}

dependencies {
    implementation("org.gradle:gradle-tooling-api:8.6")
    runtimeOnly("org.slf4j:slf4j-nop:2.0.12")
}

java { sourceCompatibility = JavaVersion.VERSION_11; targetCompatibility = JavaVersion.VERSION_11 }

tasks.shadowJar {
    archiveFileName.set("sidecar.jar")
    manifest { attributes("Main-Class" to "Sidecar") }
}
