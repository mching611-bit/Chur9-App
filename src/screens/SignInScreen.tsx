import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useAuth } from "../contexts/AuthContext";
import {
  ErrorText,
  Heading,
  LabeledInput,
  MetaText,
  PrimaryButton,
  ScreenContainer,
  SecondaryButton,
} from "../components/ui";
import type { AuthStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<AuthStackParamList, "SignIn">;

export default function SignInScreen({ navigation }: Props) {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setError(null);
    if (!email || !password) {
      setError("Enter your email and password.");
      return;
    }
    setLoading(true);
    const { error: signInError } = await signIn(email.trim(), password);
    setLoading(false);
    if (signInError) setError(signInError);
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
        <ScreenContainer>
          <MetaText>FORM CH-01 · PERSONNEL SIGN-IN</MetaText>
          <Heading>Welcome back</Heading>
          <ErrorText>{error}</ErrorText>
          <LabeledInput
            label="Email"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
          />
          <LabeledInput
            label="Password"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            placeholder="********"
          />
          <PrimaryButton title="Sign in" onPress={handleSubmit} loading={loading} />
          <SecondaryButton
            title="Need an account? Sign up"
            onPress={() => navigation.navigate("SignUp")}
          />
        </ScreenContainer>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
