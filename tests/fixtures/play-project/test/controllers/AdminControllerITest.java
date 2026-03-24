package test.controllers;

import play.test.EndpointTest;
import controllers.AdminController;

public class AdminControllerITest extends EndpointTest {
    public void testList() {
        url("admin");
        assertIsOk();
    }
    public void testCreate() {
        url("admin");
        assertIsOk();
    }
}
