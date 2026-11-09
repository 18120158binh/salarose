package com.cdp.platform.jobs.outbox.flows;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.state.MapState;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.util.Collector;

import com.cdp.platform.jobs.outbox.flows.CampaignTimerFlow.WatchTimeout;
import com.cdp.platform.shared.models.VersionedTrigger;

/**
 * Keeps each journey's pending watch timeouts, one per entry and watch node,
 * and emits each at its deadline. Processing time is the wall clock, so a timer
 * set at the deadline, an event time, fires when the deadline passes. The timer
 * removes its watch when it fires, which bounds the state.
 */
final class WatchTimerProcessFunction extends KeyedProcessFunction<String, WatchTimeout, VersionedTrigger> {

    private transient MapState<String, WatchTimeout> timeoutsByWatch;

    @Override
    public void open(OpenContext parameters) throws Exception {
        timeoutsByWatch = getRuntimeContext()
            .getMapState(new MapStateDescriptor<>("watch-timeouts", Types.STRING,
                TypeInformation.of(WatchTimeout.class)));
    }

    @Override
    public void processElement(WatchTimeout timeout, Context context, Collector<VersionedTrigger> out)
        throws Exception {
        long now = context.timerService().currentProcessingTime();
        if (timeout.deadline() <= now) {
            out.collect(timeout.toTrigger());
            return;
        }
        // A transition read again replaces its own watch instead of adding one.
        timeoutsByWatch.put(timeout.watchKey(), timeout);
        context.timerService().registerProcessingTimeTimer(timeout.deadline());
    }

    @Override
    public void onTimer(long timestamp, OnTimerContext context, Collector<VersionedTrigger> out) throws Exception {
        List<String> fired = new ArrayList<>();
        for (Map.Entry<String, WatchTimeout> entry : timeoutsByWatch.entries()) {
            if (entry.getValue().deadline() <= timestamp) {
                out.collect(entry.getValue().toTrigger());
                fired.add(entry.getKey());
            }
        }
        for (String watch : fired) {
            timeoutsByWatch.remove(watch);
        }
    }
}
