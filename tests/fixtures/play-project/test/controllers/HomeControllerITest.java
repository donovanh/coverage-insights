package test.controllers;

import play.test.EndpointTest;

public class HomeControllerITest extends EndpointTest {
    public void testIndex() {
        url("home");
        assertIsOk();
    }
    public void testSubmit() {
        url("home");
        assertIsOk();
    }
}
