package com.example.app

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*

class FormatterTest {
    @Test
    fun `should format date`() {
        assertEquals("2024/01/15", Formatter.formatDate("2024-01-15"))
    }

    @Test
    fun `should format name`() {
        assertEquals("Smith, John", Formatter.formatName("John", "Smith"))
    }
}
