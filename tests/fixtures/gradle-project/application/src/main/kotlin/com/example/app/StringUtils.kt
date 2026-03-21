package com.example.app

object StringUtils {
    fun truncate(s: String, max: Int): String = if (s.length <= max) s else s.take(max) + "..."
    fun isPalindrome(s: String): Boolean = s == s.reversed()
    fun countWords(s: String): Int = if (s.isBlank()) 0 else s.trim().split(Regex("\\s+")).size
    fun capitalize(s: String): String = s.lowercase().replaceFirstChar { it.uppercase() }
    fun repeat(s: String, n: Int): String = s.repeat(n)
}
