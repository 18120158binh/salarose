package com.cdp.platform.jobs.businessfanout;

import java.util.ArrayList;
import java.util.List;

import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.util.Collector;

/**
 * Drops a business event whose id is among the last {@link #REMEMBERED} ids
 * seen
 * for its key, the event name and item key (BEF-FR-05).
 */
final class SeenEventFilter extends KeyedProcessFunction<String, BusinessEvent, BusinessEvent> {

    static final int REMEMBERED = 1_000;

    private transient ValueState<List<String>> seen;

    @Override
    public void open(OpenContext openContext) {
        seen = getRuntimeContext().getState(new ValueStateDescriptor<>("seen-event-ids", Types.LIST(Types.STRING)));
    }

    @Override
    public void processElement(BusinessEvent event, Context context, Collector<BusinessEvent> out) throws Exception {
        List<String> ids = seen.value() == null ? new ArrayList<>() : new ArrayList<>(seen.value());
        if (ids.contains(event.eventId())) return;
        ids.add(event.eventId());
        if (ids.size() > REMEMBERED) ids.subList(0, ids.size() - REMEMBERED).clear();
        seen.update(ids);
        out.collect(event);
    }
}
