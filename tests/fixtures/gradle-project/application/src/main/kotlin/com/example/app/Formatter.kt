package com.example.app

object Formatter {
    fun formatDate(date: String): String = date.replace("-", "/")
    fun formatName(first: String, last: String): String = "$last, $first"
}
