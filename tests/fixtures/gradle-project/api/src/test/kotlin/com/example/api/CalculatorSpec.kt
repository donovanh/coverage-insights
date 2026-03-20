package com.example.api

import io.kotest.core.spec.style.DescribeSpec
import io.kotest.matchers.shouldBe

class CalculatorSpec : DescribeSpec({
    describe("Calculator") {
        it("should add two numbers") {
            Calculator.add(2, 3) shouldBe 5
        }
        it("should multiply two numbers") {
            Calculator.multiply(3, 4) shouldBe 12
        }
    }
})
