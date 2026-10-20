plugins {
    java
    id("org.springframework.boot") version "3.5.16"
    id("io.spring.dependency-management") version "1.1.7"
}

java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }

repositories { mavenCentral() }

dependencyManagement {
    imports { mavenBom("org.springframework.cloud:spring-cloud-dependencies:2025.0.3") }
}

dependencies {
    implementation("org.springframework.cloud:spring-cloud-starter-gateway-server-webflux")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("org.springframework.security:spring-security-crypto")
    implementation("com.nimbusds:nimbus-jose-jwt:9.37.4") // the version Spring Security uses in meta
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test { useJUnitPlatform() }
tasks.bootJar { archiveFileName = "app.jar" }
tasks.jar { enabled = false }
