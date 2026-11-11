plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val releaseStoreFile = providers.environmentVariable("ELANOUS_ANDROID_KEYSTORE_PATH").orNull
val releaseStorePassword = providers.environmentVariable("ELANOUS_ANDROID_KEYSTORE_PASSWORD").orNull
val releaseKeyAlias = providers.environmentVariable("ELANOUS_ANDROID_KEY_ALIAS").orNull
val releaseKeyPassword = providers.environmentVariable("ELANOUS_ANDROID_KEY_PASSWORD").orNull
val releaseBuildRequested = gradle.startParameter.taskNames.any {
    it.contains("release", ignoreCase = true) ||
        it.substringAfterLast(':').lowercase() in setOf("assemble", "build", "bundle")
}
if (releaseBuildRequested) {
    val missing = buildList {
        if (releaseStoreFile.isNullOrBlank()) add("ELANOUS_ANDROID_KEYSTORE_PATH")
        if (releaseStorePassword.isNullOrBlank()) add("ELANOUS_ANDROID_KEYSTORE_PASSWORD")
        if (releaseKeyAlias.isNullOrBlank()) add("ELANOUS_ANDROID_KEY_ALIAS")
        if (releaseKeyPassword.isNullOrBlank()) add("ELANOUS_ANDROID_KEY_PASSWORD")
    }
    require(missing.isEmpty()) {
        "Android release signing requires: ${missing.joinToString()}. See README.md."
    }
    require(file(releaseStoreFile!!).isFile) {
        "Android release keystore does not exist: $releaseStoreFile"
    }
}

android {
    namespace = "com.example.flutter_app_voice_note"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.example.flutter_app_voice_note"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        create("release") {
            if (!releaseStoreFile.isNullOrBlank() &&
                !releaseStorePassword.isNullOrBlank() &&
                !releaseKeyAlias.isNullOrBlank() &&
                !releaseKeyPassword.isNullOrBlank()) {
                storeFile = file(releaseStoreFile)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
