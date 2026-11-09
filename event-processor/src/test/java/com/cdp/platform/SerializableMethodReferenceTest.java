package com.cdp.platform;

import java.io.IOException;
import java.lang.invoke.LambdaMetafactory;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.stream.Stream;

import org.apache.flink.shaded.asm9.org.objectweb.asm.ClassReader;
import org.apache.flink.shaded.asm9.org.objectweb.asm.ClassVisitor;
import org.apache.flink.shaded.asm9.org.objectweb.asm.Handle;
import org.apache.flink.shaded.asm9.org.objectweb.asm.MethodVisitor;
import org.apache.flink.shaded.asm9.org.objectweb.asm.Opcodes;
import org.apache.flink.shaded.asm9.org.objectweb.asm.Type;

import com.cdp.platform.jobs.customerdecision.CustomerDecisionJob;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * javac writes one {@code $deserializeLambda$} per class. It tells serializable
 * method references apart by the method and the interface, not by the types
 * they are used at. Once Flink ships a job's functions, every use of one method
 * reference runs with the casts of its first use in the class, and the others
 * fail with a {@code ClassCastException}.
 */
class SerializableMethodReferenceTest {

    @Test
    void noClassUsesOneSerializableMethodReferenceAtTwoTypes() throws IOException, URISyntaxException {
        Path classes = Path.of(CustomerDecisionJob.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        List<Path> classFiles;
        try (Stream<Path> files = Files.walk(classes)) {
            classFiles = files.filter(file -> file.toString().endsWith(".class")).toList();
        }

        List<String> clashes = new ArrayList<>();
        for (Path classFile : classFiles) {
            clashes.addAll(clashes(Files.readAllBytes(classFile)));
        }

        assertEquals(List.of(), clashes);
    }

    private static List<String> clashes(byte[] classFile) {
        Map<String, Set<String>> typesByReference = new TreeMap<>();
        ClassReader reader = new ClassReader(classFile);
        reader.accept(new ClassVisitor(Opcodes.ASM9) {
            @Override
            public MethodVisitor visitMethod(int access, String name, String descriptor, String signature,
                String[] exceptions) {
                return new MethodVisitor(Opcodes.ASM9) {
                    @Override
                    public void visitInvokeDynamicInsn(String lambdaName, String lambdaDescriptor, Handle bootstrap,
                        Object... arguments) {
                        if (isSerializableLambda(bootstrap, arguments)) {
                            Handle implementation = (Handle) arguments[1];
                            String reference = Type.getReturnType(lambdaDescriptor).getClassName() + " "
                                + implementation.getOwner() + "." + implementation.getName()
                                + implementation.getDesc();
                            typesByReference
                                .computeIfAbsent(reference, key -> new TreeSet<>())
                                .add(((Type) arguments[2]).getDescriptor());
                        }
                    }
                };
            }
        }, ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);

        return typesByReference
            .entrySet()
            .stream()
            .filter(reference -> reference.getValue().size() > 1)
            .map(reference -> reader.getClassName() + " uses " + reference.getKey() + " at " + reference.getValue())
            .toList();
    }

    private static boolean isSerializableLambda(Handle bootstrap, Object[] arguments) {
        return "java/lang/invoke/LambdaMetafactory".equals(bootstrap.getOwner())
            && "altMetafactory".equals(bootstrap.getName())
            && ((Integer) arguments[3] & LambdaMetafactory.FLAG_SERIALIZABLE) != 0;
    }
}
