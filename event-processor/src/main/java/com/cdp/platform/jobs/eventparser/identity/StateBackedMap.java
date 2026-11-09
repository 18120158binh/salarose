package com.cdp.platform.jobs.eventparser.identity;

import java.util.AbstractMap;
import java.util.AbstractSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;

import org.apache.flink.api.common.state.MapState;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.util.FlinkRuntimeException;

/**
 * A map whose entries live in keyed {@link MapState}, so that a lookup or a
 * change touches one entry instead of the whole structure. With a counter,
 * {@link #size()} reads one value instead of every entry.
 */
final class StateBackedMap<V> extends AbstractMap<String, V> {

    private final MapState<String, V> entries;
    private final ValueState<Integer> counter;

    /**
     * @param counter
     *            the number of entries, kept up to date by this map, or null to
     *            count by reading every entry
     */
    StateBackedMap(MapState<String, V> entries, ValueState<Integer> counter) {
        this.entries = entries;
        this.counter = counter;
    }

    @Override
    public V get(Object key) {
        try {
            return entries.get((String) key);
        } catch (Exception exception) {
            throw new FlinkRuntimeException("Failed to read identity state", exception);
        }
    }

    @Override
    public boolean containsKey(Object key) {
        try {
            return entries.contains((String) key);
        } catch (Exception exception) {
            throw new FlinkRuntimeException("Failed to read identity state", exception);
        }
    }

    @Override
    public V put(String key, V value) {
        V previous = get(key);
        try {
            entries.put(key, value);
            if (previous == null && counter != null) counter.update(size() + 1);
        } catch (Exception exception) {
            throw new FlinkRuntimeException("Failed to write identity state", exception);
        }
        return previous;
    }

    @Override
    public void clear() {
        entries.clear();
        if (counter != null) counter.clear();
    }

    @Override
    public int size() {
        if (counter == null) return super.size();
        try {
            Integer count = counter.value();
            return count == null ? 0 : count;
        } catch (Exception exception) {
            throw new FlinkRuntimeException("Failed to read identity state", exception);
        }
    }

    @Override
    public Set<Map.Entry<String, V>> entrySet() {
        return new AbstractSet<>() {
            @Override
            public Iterator<Map.Entry<String, V>> iterator() {
                try {
                    return entries.iterator();
                } catch (Exception exception) {
                    throw new FlinkRuntimeException("Failed to read identity state", exception);
                }
            }

            @Override
            public int size() {
                int count = 0;
                for (Iterator<Map.Entry<String, V>> entry = iterator(); entry.hasNext(); entry.next()) {
                    count++;
                }
                return count;
            }
        };
    }
}
