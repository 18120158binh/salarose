package com.cdp.platform.shared.db.repositories;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.apache.flink.api.dag.Transformation;
import org.apache.flink.cdc.connectors.postgres.source.PostgresSourceBuilder.PostgresIncrementalSource;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.configuration.CoreOptions;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.graph.StreamEdge;
import org.apache.flink.streaming.api.graph.StreamGraph;
import org.apache.flink.streaming.api.graph.StreamNode;
import org.apache.flink.streaming.api.transformations.SourceTransformation;
import org.apache.flink.streaming.runtime.partitioner.BroadcastPartitioner;
import org.apache.flink.streaming.runtime.partitioner.ForwardPartitioner;
import org.apache.flink.streaming.runtime.partitioner.KeyGroupStreamPartitioner;

/**
 * Checks that a job reads each CDC table in log order. A source that runs on
 * several subtasks, or a channel other than forward before a broadcast, lets a
 * change overtake an earlier one, such as a save's insert overtaking its
 * delete.
 */
public final class CdcStreamOrder {

    /** The parallelism the jobs are built with, so that one subtask is a choice. */
    public static final int JOB_PARALLELISM = 4;

    private CdcStreamOrder() {
    }

    /** Job settings with a parallelism above 1. */
    public static Configuration settings() {
        Configuration settings = new Configuration();
        settings.set(CoreOptions.DEFAULT_PARALLELISM, JOB_PARALLELISM);
        return settings;
    }

    /**
     * What breaks the log order of each CDC source of the job: a source or an
     * operator before its first broadcast on more than one subtask, or a channel
     * other than forward before that broadcast. A stream stops at a key, which
     * keeps the order of each key's changes. Empty when every CDC stream keeps its
     * order.
     */
    public static List<String> breaks(StreamExecutionEnvironment job) {
        Set<Integer> sourceIds = new HashSet<>();
        Deque<Transformation<?>> pending = new ArrayDeque<>(job.getTransformations());
        Set<Integer> seen = new HashSet<>();
        while (!pending.isEmpty()) {
            Transformation<?> transformation = pending.poll();
            if (!seen.add(transformation.getId())) {
                continue;
            }
            if (transformation instanceof SourceTransformation<?, ?, ?> source
                && source.getSource() instanceof PostgresIncrementalSource) {
                sourceIds.add(source.getId());
            }
            pending.addAll(transformation.getInputs());
        }

        StreamGraph graph = job.getStreamGraph();
        List<String> breaks = new ArrayList<>();
        if (sourceIds.isEmpty()) {
            breaks.add("The job has no CDC source");
        }
        for (Integer sourceId : sourceIds) {
            StreamNode source = graph.getStreamNode(sourceId);
            if (source.getParallelism() != 1) {
                breaks.add(source.getOperatorName() + " runs on " + source.getParallelism() + " subtasks");
            }
            walk(graph, source, source, true, breaks);
        }
        return breaks;
    }

    private static void walk(StreamGraph graph, StreamNode source, StreamNode node, boolean inOrder,
        List<String> breaks) {
        for (StreamEdge edge : node.getOutEdges()) {
            StreamNode target = graph.getStreamNode(edge.getTargetId());
            if (edge.getPartitioner() instanceof BroadcastPartitioner) {
                if (!inOrder) {
                    breaks.add(source.getOperatorName() + " reaches " + target.getOperatorName() + " out of order");
                }
            } else if (!(edge.getPartitioner() instanceof KeyGroupStreamPartitioner)) {
                boolean forward = edge.getPartitioner() instanceof ForwardPartitioner && target.getParallelism() == 1;
                walk(graph, source, target, inOrder && forward, breaks);
            }
        }
    }
}
