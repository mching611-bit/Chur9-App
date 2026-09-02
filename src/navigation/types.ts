export type AuthStackParamList = {
  SignIn: undefined;
  SignUp: undefined;
};

export type AppStackParamList = {
  TaskList: undefined;
  TaskForm: { taskId: string; instanceId: string } | undefined;
};
