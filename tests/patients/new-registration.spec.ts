import { test, expect, patients, recordUhid } from '../../fixtures/test';
import type { PatientData } from '../../pages/PatientRegistrationPage';

/**
 * The form writes to live data, so a fixed mobile number would collide with the
 * patient the previous run registered. Each run gets its own.
 */
function uniqueMobile() {
  return `017${Date.now().toString().slice(-8)}`;
}

test.describe('New patient registration', () => {
  test('registers a patient with complete details', async ({ registrationPage }) => {
    // Every field on this form round-trips over the circuit as it is typed, and
    // there are twenty-odd of them, so a slow afternoon on the server takes it
    // past the 90s the rest of the suite gets.
    test.setTimeout(180_000);

    const patient: PatientData = { ...patients.valid, mobile: uniqueMobile() };

    await registrationPage.fillPatient(patient);

    // The name fields are upper-cased by the app as they are typed.
    await expect(registrationPage.field('Full Name')).toHaveValue(patient.fullName.toUpperCase());
    await expect(registrationPage.field('Mobile No')).toHaveValue(patient.mobile);
    await expect(registrationPage.field('District')).toHaveValue(patient.district);
    await expect(registrationPage.dateOfBirth).toHaveValue(patient.dateOfBirth);
    // Age is derived from the date of birth rather than typed.
    await expect(registrationPage.ageYears).not.toHaveValue('0');

    await registrationPage.confirmRegistration();

    const patientId = await registrationPage.expectRegistered();
    expect(patientId).toMatch(/^\d+$/);

    // The invoice spec bills whichever UHID was registered last.
    recordUhid(patientId);

    await registrationPage.acknowledgeRegistration();
  });
});
