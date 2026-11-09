package com.cdp.platform.jobs.customerdecision.transforms;

import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.db.MetricConfig;

import static com.cdp.platform.shared.models.EventFieldNames.COLLIDING;
import static com.cdp.platform.shared.models.EventFieldNames.FROM_JSON;
import static com.cdp.platform.shared.models.EventFieldNames.jsonWith;
import static com.cdp.platform.shared.models.EventFieldNames.withEveryField;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class CustomerBehaviorProcessFunctionTest {

    private static Event addToCart(String eventJson) {
        return new Event("customer-42", "d1", null, null, "add_to_cart", 1_785_800_000_000L, null, null, null,
            null, "web", eventJson, "event-1");
    }

    private static MetricConfig metric(String valueType) {
        return new MetricConfig("m_cart_value", "cart value", "", "add_to_cart", null, null, "SUM", "value", valueType,
            0L, true);
    }

    @Test
    void aMetricAttributeNamedOutsideTheContractListReadsEventJson() {
        assertAll(COLLIDING.stream().map(name -> () -> {
            MetricConfig lastValue = new MetricConfig("m_cart_attr", "cart attr", "", "add_to_cart", null, null,
                "LAST", name, "STRING", 0L, true);

            assertEquals(FROM_JSON,
                CustomerBehaviorProcessFunction.typedValue(withEveryField(jsonWith(name)), lastValue), name);
        }));
    }

    @Test
    void nonNumericValueOfNumberMetricHasNoValue() {
        Object value = CustomerBehaviorProcessFunction.typedValue(addToCart("{\"value\":\"abc\"}"), metric("NUMBER"));

        assertEquals(null, value);
    }

    @Test
    void notANumberValueOfNumberMetricHasNoValue() {
        Object value = CustomerBehaviorProcessFunction.typedValue(addToCart("{\"value\":\"NaN\"}"), metric("NUMBER"));

        assertEquals(null, value);
    }

    @Test
    void infiniteValueOfNumberMetricHasNoValue() {
        Object value = CustomerBehaviorProcessFunction
            .typedValue(addToCart("{\"value\":\"Infinity\"}"), metric("NUMBER"));

        assertEquals(null, value);
    }

    @Test
    void numericValueOfNumberMetricIsCounted() {
        Object value = CustomerBehaviorProcessFunction
            .typedValue(addToCart("{\"value\":\"12990000\"}"), metric("NUMBER"));

        assertEquals(12_990_000.0, value);
    }

    /**
     * A definition restored from state keeps the value type as its row had it,
     * which a database without the column's check may hold in lower case.
     */
    @Test
    void aRestoredValueTypeInLowerCaseStillReadsTheValue() {
        Object value = CustomerBehaviorProcessFunction
            .typedValue(addToCart("{\"value\":\"12990000\"}"), metric("number"));

        assertEquals(12_990_000.0, value);
    }

    @Test
    void nonBooleanValueOfBooleanMetricHasNoValue() {
        Object value = CustomerBehaviorProcessFunction.typedValue(addToCart("{\"value\":\"yes\"}"), metric("BOOLEAN"));

        assertEquals(null, value);
    }

    @Test
    void booleanValuesOfBooleanMetricAreCounted() {
        assertEquals(true,
            CustomerBehaviorProcessFunction.typedValue(addToCart("{\"value\":\"TRUE\"}"), metric("BOOLEAN")));
        assertEquals(false,
            CustomerBehaviorProcessFunction.typedValue(addToCart("{\"value\":false}"), metric("BOOLEAN")));
    }

    @Test
    void firstChangeForAPersonWithNoStoredRowsGetsVersionOne() {
        assertEquals(1, CustomerBehaviorProcessFunction.nextBehaviorVersion(null, () -> 0L));
    }

    @Test
    void changeAfterLostStateGetsOneMoreThanTheHighestStoredRowVersion() {
        assertEquals(42, CustomerBehaviorProcessFunction.nextBehaviorVersion(null, () -> 41L));
    }

    @Test
    void nextChangeGetsOneMoreThanTheCounterInState() {
        assertEquals(8, CustomerBehaviorProcessFunction.nextBehaviorVersion(7L, () -> {
            throw new AssertionError("must not read user_metrics when the counter is in state");
        }));
    }

    @Test
    void failedReadOfTheStoredRowVersionGivesNoVersion() {
        IllegalStateException readFailure = new IllegalStateException("user_metrics is unreachable");

        IllegalStateException thrown = assertThrows(IllegalStateException.class,
            () -> CustomerBehaviorProcessFunction.nextBehaviorVersion(null, () -> {
                throw readFailure;
            }));

        assertSame(readFailure, thrown);
    }
}
