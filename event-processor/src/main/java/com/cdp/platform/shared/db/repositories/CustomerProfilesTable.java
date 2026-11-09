package com.cdp.platform.shared.db.repositories;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

import com.cdp.platform.shared.models.db.UserProfile;

import org.jooq.Field;
import org.jooq.SQLDialect;
import org.jooq.Table;
import org.jooq.conf.ParamType;
import org.jooq.impl.DSL;

/**
 * The table {@code customer_profiles}: one profile per customer. Another
 * system owns it, so {@code schema.sql} does not define it. Customer decision
 * reads it by {@code cdp_uuid}.
 */
public final class CustomerProfilesTable {

    public static final String TABLE_NAME = "customer_profiles";

    public static final String FID = "fid";
    public static final String CARDCODE = "cardcode";
    public static final String CUSTOMER_ID = "customer_id";
    public static final String PHONE = "phone";
    public static final String EMAIL = "email";
    public static final String NAME = "name";
    public static final String FIRST_NAME = "first_name";
    public static final String PRONOUN = "pronoun";
    public static final String GENDER = "gender";
    public static final String AGE = "age";
    public static final String CITY = "city";
    public static final String ENV = "env";
    public static final String CDP_UUID = "cdp_uuid";
    public static final String NETWORK_USER_ID = "network_user_id";
    public static final String USER_TIME = "user_time";

    /** Every column of a profile, in the order of {@link UserProfile}. */
    public static final List<String> COLUMNS = List
        .of(FID, CARDCODE, CUSTOMER_ID, PHONE, EMAIL, NAME, FIRST_NAME, PRONOUN, GENDER, AGE, CITY, ENV, CDP_UUID,
            NETWORK_USER_ID, USER_TIME);

    private static final List<String> FIELD_PREFIXES = List.of("profile.", "user.");
    private static final Table<?> TABLE = DSL.table(DSL.name(TABLE_NAME));
    private static final Field<String> CDP_UUID_FIELD = DSL.field(DSL.name(CDP_UUID), String.class);

    private CustomerProfilesTable() {
    }

    /**
     * The column that a {@code profile_property} field names, such as
     * {@code city} for {@code profile.city}. The legacy prefix {@code user.}
     * names the same column. Any other field names no column.
     */
    public static Optional<String> columnOf(String field) {
        if (field == null) return Optional.empty();
        return FIELD_PREFIXES
            .stream()
            .filter(field::startsWith)
            .map(prefix -> field.substring(prefix.length()))
            .filter(COLUMNS::contains)
            .findFirst();
    }

    /**
     * The given columns of the profile whose {@code cdp_uuid} is the one
     * parameter, if any. The columns are among {@link #COLUMNS}, and there is at
     * least one.
     */
    static String lookupSql(Collection<String> columns) {
        return DSL
            .using(SQLDialect.POSTGRES)
            .select(columns.stream().map(CustomerProfilesTable::column).toList())
            .from(TABLE)
            .where(CDP_UUID_FIELD.eq(DSL.val(null, CDP_UUID_FIELD)))
            .limit(DSL.inline(1))
            .getSQL(ParamType.INDEXED);
    }

    /**
     * The profile in the current row of a {@link #lookupSql} result that read the
     * given columns. The other fields are null.
     */
    static UserProfile profile(ResultSet row, Collection<String> columns) throws SQLException {
        Reader read = new Reader(row, columns);
        return new UserProfile(
            read.number(FID) == null ? null : row.getLong(FID),
            read.text(CARDCODE),
            read.text(CUSTOMER_ID),
            read.text(PHONE),
            read.text(EMAIL),
            read.text(NAME),
            read.text(FIRST_NAME),
            read.text(PRONOUN),
            read.text(GENDER),
            read.number(AGE) == null ? null : row.getDouble(AGE),
            read.text(CITY),
            read.text(ENV),
            read.text(CDP_UUID),
            read.text(NETWORK_USER_ID),
            read.text(USER_TIME));
    }

    private static Field<Object> column(String name) {
        return DSL.field(DSL.name(name));
    }

    /** Reads a column of the row only when the query selected it. */
    private record Reader(ResultSet row, Collection<String> columns) {

        String text(String column) throws SQLException {
            return columns.contains(column) ? row.getString(column) : null;
        }

        Object number(String column) throws SQLException {
            return columns.contains(column) ? row.getObject(column) : null;
        }
    }
}
