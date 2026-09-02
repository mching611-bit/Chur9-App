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

type Props = NativeStackScreenProps<AuthStackParamList, "SignUp">;

export default function SignUpScreen({ navigation }: Props) {
  const { signUp } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setError(null);
    setInfo(null);
    if (!email || !password) {
      setError("Enter an email and password.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    const { error: signUpError } = await signUp(email.trim(), password);
    setLoading(false);
    if (signUpError) {
      setError(signUpError);
      return;
    }
    setInfo("Account created. If email confirmation is required, check your inbox, then sign in.");
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
        <ScreenContainer>
          <MetaText>FORM CH-02 · NEW HIRE INTAKE</MetaText>
          <Heading>Create your account</Heading>
          <ErrorText>{error}</ErrorText>
          {info ? <MetaText>{info}</MetaText> : null}
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
            placeholder="At least 6 characters"
          />
          <LabeledInput
            label="Confirm password"
            secureTextEntry
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            placeholder="********"
          />
          <PrimaryButton title="Sign up" onPress={handleSubmit} loading={loading} />
          <SecondaryButton
            title="Already have an account? Sign in"
            onPress={() => navigation.navigate("SignIn")}
          />
        </ScreenContainer>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
