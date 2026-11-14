package com.cdp.platform.jobs.importapplier;

import java.util.Locale;
import java.util.Optional;

import com.google.i18n.phonenumbers.NumberParseException;
import com.google.i18n.phonenumbers.PhoneNumberUtil;
import com.google.i18n.phonenumbers.PhoneNumberUtil.PhoneNumberFormat;
import com.google.i18n.phonenumbers.Phonenumber.PhoneNumber;

/**
 * Normalizes emails and phones by Validate each row (IAP-FR-08). A value that
 * fails is empty: the caller drops and counts it and keeps the row.
 */
final class Contacts {

    private static final PhoneNumberUtil PHONES = PhoneNumberUtil.getInstance();

    private final String defaultCountry;

    /**
     * @param defaultCountry
     *            ISO 3166-1 alpha-2 region for numbers without a country code
     */
    Contacts(String defaultCountry) {
        if (!PHONES.getSupportedRegions().contains(defaultCountry)) {
            throw new IllegalArgumentException("not a phone region: " + defaultCountry);
        }
        this.defaultCountry = defaultCountry;
    }

    /** Trim, then lowercase. Exactly one {@code @}, with text on each side. */
    static Optional<String> email(String value) {
        String email = value.trim().toLowerCase(Locale.ROOT);
        int at = email.indexOf('@');
        if (at <= 0 || at != email.lastIndexOf('@') || at == email.length() - 1) return Optional.empty();
        return Optional.of(email);
    }

    /**
     * Trim, then E.164, reading a number without a country code in the default
     * country.
     */
    Optional<String> phone(String value) {
        try {
            PhoneNumber number = PHONES.parse(value.trim(), defaultCountry);
            return PHONES.isValidNumber(number)
                ? Optional.of(PHONES.format(number, PhoneNumberFormat.E164))
                : Optional.empty();
        } catch (NumberParseException e) {
            return Optional.empty();
        }
    }
}
