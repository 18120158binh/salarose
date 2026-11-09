package com.cdp.platform.jobs.customerdecision;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import org.apache.flink.api.common.serialization.DeserializationSchema;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.configuration.DelegatingConfiguration;
import org.apache.flink.metrics.MetricGroup;
import org.apache.flink.runtime.metrics.groups.UnregisteredMetricGroups;
import org.apache.flink.table.api.DataTypes;
import org.apache.flink.table.api.Schema;
import org.apache.flink.table.api.TableDescriptor;
import org.apache.flink.table.data.RowData;
import org.apache.flink.table.factories.DeserializationFormatFactory;
import org.apache.flink.table.factories.FactoryUtil;
import org.apache.flink.table.runtime.connector.source.ScanRuntimeProviderContext;
import org.apache.flink.table.types.DataType;
import org.apache.flink.util.Collector;
import org.apache.flink.util.UserCodeClassLoader;

/**
 * Decodes Kafka record values with the value format a table descriptor names.
 */
final class TableFormats {

    private TableFormats() {
    }

    /**
     * Runs each message through the value format that the table names, with the
     * format options the table sets.
     */
    static List<RowData> read(TableDescriptor table, String... messages) throws Exception {
        String format = table.getOptions().get("format");
        DeserializationSchema<RowData> decoder = FactoryUtil
            .discoverFactory(TableFormats.class.getClassLoader(), DeserializationFormatFactory.class, format)
            .createDecodingFormat(null,
                new DelegatingConfiguration(Configuration.fromMap(table.getOptions()), format + "."))
            .createRuntimeDecoder(ScanRuntimeProviderContext.INSTANCE, physicalType(table));
        decoder.open(new DeserializationSchema.InitializationContext() {
            @Override
            public MetricGroup getMetricGroup() {
                return UnregisteredMetricGroups.createUnregisteredOperatorMetricGroup();
            }

            @Override
            public UserCodeClassLoader getUserCodeClassLoader() {
                return null;
            }
        });
        List<RowData> rows = new ArrayList<>();
        Collector<RowData> collector = new Collector<>() {
            @Override
            public void collect(RowData row) {
                rows.add(row);
            }

            @Override
            public void close() {
            }
        };
        for (String message : messages) {
            decoder.deserialize(message.getBytes(StandardCharsets.UTF_8), collector);
        }
        return rows;
    }

    /** The row the format decodes: the table's physical columns. */
    static DataType physicalType(TableDescriptor table) {
        Schema schema = table.getSchema().orElseThrow();
        return DataTypes
            .ROW(schema
                .getColumns()
                .stream()
                .filter(Schema.UnresolvedPhysicalColumn.class::isInstance)
                .map(Schema.UnresolvedPhysicalColumn.class::cast)
                .map(column -> DataTypes.FIELD(column.getName(), (DataType) column.getDataType()))
                .toArray(DataTypes.Field[]::new));
    }
}
