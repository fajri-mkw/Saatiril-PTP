package com.saatiril.andro.util

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit test JVM untuk FilenameUtils — memastikan konvensi penamaan foto
 * sama dengan aplikasi Windows/Electron (paritas lintas platform).
 */
class FilenameUtilsTest {

    // ── Mode standar (Toga + Ijazah) ──

    @Test
    fun standardMode_toga_v1() {
        assertEquals(
            "12345678_Budi_Santoso_1_Toga.jpg",
            FilenameUtils.buildStandardFilename("12345678", "Budi Santoso", 1, "Toga")
        )
    }

    @Test
    fun standardMode_ijazah_v1() {
        assertEquals(
            "12345678_Budi_Santoso_2_Ijazah.jpg",
            FilenameUtils.buildStandardFilename("12345678", "Budi Santoso", 2, "Ijazah")
        )
    }

    @Test
    fun standardMode_retake_v2() {
        assertEquals(
            "12345678_Budi_Santoso_1_Toga_v2.jpg",
            FilenameUtils.buildStandardFilename("12345678", "Budi Santoso", 1, "Toga", version = 2)
        )
    }

    @Test
    fun standardMode_retake_v3() {
        assertEquals(
            "12345678_Budi_Santoso_2_Ijazah_v3.jpg",
            FilenameUtils.buildStandardFilename("12345678", "Budi Santoso", 2, "Ijazah", version = 3)
        )
    }

    // ── Mode photoshoot ──

    @Test
    fun photoshootMode_channel1() {
        assertEquals(
            "12345678_Budi_Santoso.jpg",
            FilenameUtils.buildPhotoshootFilename("12345678", "Budi Santoso", 1)
        )
    }

    @Test
    fun photoshootMode_channel2() {
        assertEquals(
            "12345678_Budi_Santoso_Ch2.jpg",
            FilenameUtils.buildPhotoshootFilename("12345678", "Budi Santoso", 2)
        )
    }

    @Test
    fun photoshootMode_channel3_retake() {
        assertEquals(
            "12345678_Budi_Santoso_Ch3_v2.jpg",
            FilenameUtils.buildPhotoshootFilename("12345678", "Budi Santoso", 3, version = 2)
        )
    }

    // ── Sanitasi input ──

    @Test
    fun sanitasi_nama_dengan_karakter_spesial() {
        // Spasi → underscore; karakter non-alfanumerik dihapus
        assertEquals(
            "1234_AnnieMae_OConner_1_Toga.jpg",
            FilenameUtils.buildStandardFilename("1234", "Annie-Mae O'Conner", 1, "Toga")
        )
    }

    @Test
    fun sanitasi_nim_dengan_karakter_terlarang() {
        // NIM hanya boleh alfanumerik, underscore, dan hyphen;
        // karakter lain ("/", " ") dihapus seluruhnya
        assertEquals(
            "1234ab_Candra_1_Toga.jpg",
            FilenameUtils.buildStandardFilename("12/34 ab", "Candra", 1, "Toga")
        )
    }

    @Test
    fun sanitasi_null_dan_kosong() {
        // null → string kosong, tidak crash
        assertEquals(
            "__1_Toga.jpg",
            FilenameUtils.buildStandardFilename(null, null, 1, "Toga")
        )
    }

    @Test
    fun sanitasi_nama_multi_spasi() {
        // Banyak spasi berurutan → satu underscore
        assertEquals(
            "123_Rina_Melati_1_Toga.jpg",
            FilenameUtils.buildStandardFilename("123", "Rina  Melati", 1, "Toga")
        )
    }
}
