#!/bin/bash
# Pre-flight: kompilasi & jalankan unit test JVM (FilenameUtilsTest, CryptoUtilsTest)
# dengan kotlinc lokal + JUnit 4 — mensimulasikan `./gradlew testDebugUnitTest` CI.
set -e

WORK=/tmp/ktcheck/preflight
OUT=$WORK/out
rm -rf "$OUT"
mkdir -p "$OUT"

KOTLIN_HOME=/tmp/kotlinc-dist/kotlinc
APP=/home/z/my-project/app/src/main/java
TEST=/home/z/my-project/app/src/test/java

export JAVA_HOME=/tmp/jdk21
export PATH=$JAVA_HOME/bin:$PATH

# ── Ambil jar JUnit + hamcrest dari Maven Central ──
JUNIT_JAR=$WORK/junit-4.13.2.jar
HAMCREST_JAR=$WORK/hamcrest-core-1.3.jar
[ -f "$JUNIT_JAR" ] || curl -sL -o "$JUNIT_JAR" https://repo1.maven.org/maven2/junit/junit/4.13.2/junit-4.13.2.jar
[ -f "$HAMCREST_JAR" ] || curl -sL -o "$HAMCREST_JAR" https://repo1.maven.org/maven2/org/hamcrest/hamcrest-core/1.3/hamcrest-core-1.3.jar

# ── Kompilasi sumber utama (hanya kelas util murni — tanpa dependency Android) ──
echo "=== [1/3] Kompilasi main: FilenameUtils.kt + Sha256.kt ==="
"$KOTLIN_HOME/bin/kotlinc" -nowarn -d "$OUT/main" \
  "$APP/com/saatiril/andro/util/FilenameUtils.kt" \
  "$APP/com/saatiril/andro/util/Sha256.kt" 2>&1 | head -20

# ── Kompilasi test ──
echo "=== [2/3] Kompilasi test ==="
"$KOTLIN_HOME/bin/kotlinc" -nowarn \
  -classpath "$OUT/main:$JUNIT_JAR:$HAMCREST_JAR" \
  -d "$OUT/test" \
  "$TEST/com/saatiril/andro/util/FilenameUtilsTest.kt" \
  "$TEST/com/saatiril/andro/util/CryptoUtilsTest.kt" 2>&1 | head -20

# ── Jalankan dengan JUnitCore ──
echo "=== [3/3] Jalankan test ==="
java -cp "$OUT/main:$OUT/test:$JUNIT_JAR:$HAMCREST_JAR:$KOTLIN_HOME/lib/kotlin-stdlib.jar" \
  org.junit.runner.JUnitCore \
  com.saatiril.andro.util.FilenameUtilsTest \
  com.saatiril.andro.util.CryptoUtilsTest
