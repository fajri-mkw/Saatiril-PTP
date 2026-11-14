package com.saatiril.andro.util

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit test JVM untuk CryptoUtils.sha256 — vektor uji resmi NIST/FIPS 180-4.
 * Dipakai untuk verifikasi password sesi (paritas dengan aplikasi Electron).
 */
class CryptoUtilsTest {

    @Test
    fun sha256_vektor_nist_abc() {
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            CryptoUtils.sha256("abc")
        )
    }

    @Test
    fun sha256_string_kosong() {
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            CryptoUtils.sha256("")
        )
    }

    @Test
    fun sha256_password_sampel() {
        // Vektor umum "password123" — dipakai sebagai sampel password sesi
        assertEquals(
            "ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f",
            CryptoUtils.sha256("password123")
        )
    }

    @Test
    fun sha256_output_selalu_64_hex() {
        for (s in listOf("a", "saatiril", "wisuda 2026", "😀".repeat(10))) {
            assertEquals(64, CryptoUtils.sha256(s).length)
        }
    }
}
