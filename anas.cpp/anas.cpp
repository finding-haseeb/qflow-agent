#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    string s;
    cin >> s;

    vector<pair<char,int>> runs;
    int n = s.size();

    for (int i = 0; i < n; ) {
        int j = i;
        while (j < n && s[j] == s[i]) j++;
        runs.push_back({s[i], j - i});
        i = j;
    }

    int m = runs.size();
    long long ans = 0;

    for (int i = 0; i < m; i++) {
        if (runs[i].second != 2) continue;

        int l = i - 1;
        int r = i + 1;
        bool ok = true;

        while (true) {
            if (l < 0 && r >= m) break;

            if (l < 0 || r >= m) {
                ok = false;
                break;
            }

            if (runs[l].first != runs[r].first) {
                ok = false;
                break;
            }

            if (runs[l].second + runs[r].second < 3) {
                ok = false;
                break;
            }

            l--;
            r++;
        }

        if (ok) ans += 3;
    }

    cout << ans;
    return 0;
}