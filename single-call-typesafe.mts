import { noul, TypeSafeClient } from '@typesafe-ai/sdk';

const client = new TypeSafeClient(); // reads TYPESAFE_API_KEY
const { answers } = await client.systemOne({
  state: { Caustic_Supply_Valve: true, Caustic_Return_Valve: true, Return_Temp: 180 },
  questions: {
    running: noul('Evaluate: Caustic_Supply_Valve == true && Caustic_Return_Valve == true && Return_Temp > 150'),
  },
});

console.log(answers.running); // { type: 'noul', noul: 0.98 }