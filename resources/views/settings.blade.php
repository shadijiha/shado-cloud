@extends('layouts.index')

@section('scripts')
@endsection

@section('content')
    <div>
        <h1>API Tokens</h1>
        <form action="{{route("generate")}}" method="post">
            @csrf
            <table>
                <tr>
                    <td>
                        <b>Generate a new key</b>
                    </td>
                    <td>
                        <select name="readonly">
                            <option value="1">Type</option>
                            <option value="1">Readonly</option>
                            <option value="0">Read & write</option>
                        </select>
                    </td>
                    <td>
                        <input type="datetime-local" name="expiration"/>
                    </td>
                    <td>
                        <input type="number" name="max_requests" placeholder="Max requests"/>
                    </td>
                    <td>
                        <input type="submit" value="Generate"/>
                    </td>
                </tr>
            </table>
        </form>
        <br/>
        <table>
            <tr>
                <th>
                </th>
                <th>
                    Key
                </th>
                <th>
                    Requests
                </th>
                <th>
                    Type
                </th>
                <th>
                    Expires at
                </th>
                <th>
                    Time remaining
                </th>
            </tr>
            @foreach($tokens as $token)
                <tr>
                    <td>
                        @if ($token->isValid())
                            <i class="fas fa-check-circle" style="color: green;"></i>
                        @else
                            <i class="fas fa-times-circle" style="color: red;"></i>
                        @endif
                    </td>
                    <td>
                        <input type="text" value="{{$token->key}}" readonly style="width: 300px;"/>
                    </td>
                    <td>
                        {{$token->requests}} /{{$token->max_requests}}
                    </td>
                    <td>
                        @if($token->readonly)
                            Readonly
                        @else
                            Read & write
                        @endif
                    </td>
                    <td>
                        {{$token->expires_at}}
                    </td>
                    <td>
                        @if ($token->isValid())
                            {{\Illuminate\Support\Carbon::parse($token->expires_at)->diff(\Illuminate\Support\Carbon::now())->format("%dD %hh %m m %s s")}}
                        @else
                            -
                        @endif
                    </td>
                </tr>
            @endforeach
        </table>
    </div>
@endsection
