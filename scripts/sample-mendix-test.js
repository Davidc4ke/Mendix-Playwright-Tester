/**
 * sample-mendix-test.js
 * 
 * Example of what a Playwright Codegen recording looks like
 * AFTER being cleaned up for Mendix.
 * 
 * This is what a tester would record with:
 *   npx playwright codegen https://your-client-app.mendixcloud.com
 * 
 * Then clean up the selectors to use mx-name-* conventions.
 * 
 * To test this script standalone:
 *   npx playwright test scripts/sample-mendix-test.js
 */

test('Create a new ticket in client app', async ({ page }) => {

  // Step 1: Login
  // The mx.login helper handles the standard Mendix login page
  await mx.login(page, TARGET_URL, CREDENTIALS.username, CREDENTIALS.password);

  // Step 2: Navigate to ticket list
  // Use mx-name-* selectors — these come from widget names in Studio Pro
  await mx.clickWidget(page, 'navTickets');
  await mx.waitForMendix(page);

  // Step 3: Click "New Ticket" button
  await mx.clickWidget(page, 'btnNewTicket');
  await mx.waitForPopup(page);

  // Step 4: Fill in ticket details
  await mx.fillWidget(page, 'txtTitle', 'UAT Test: Button alignment issue on mobile');
  await mx.fillWidget(page, 'txtDescription', 'The submit button overlaps the form on iPhone SE viewport.');
  await mx.selectDropdown(page, 'ddPriority', 'High');
  await mx.selectDropdown(page, 'ddCategory', 'UI Bug');

  // Step 5: Save the ticket
  await mx.clickWidget(page, 'btnSave');
  await mx.waitForMicroflow(page);

  // Step 6: Verify — check we're back on the list and the ticket appears
  await mx.waitForMendix(page);
  
  const statusText = await mx.getWidgetText(page, 'lblTicketStatus');
  expect(statusText).toContain('Open');

  // Step 7: Screenshot for evidence
  await page.screenshot({ 
    path: 'results/ticket-created.png', 
    fullPage: true 
  });
});
